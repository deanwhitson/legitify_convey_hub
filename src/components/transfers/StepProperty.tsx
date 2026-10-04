import React, { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { readNavigationState } from '@/lib/navigationState'
import { Building, MapPin, Home, FileText, Map as MapIcon, Search, Link2, X } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui'
import { Input } from '@/components/ui'
import { apiRequest } from '@/lib/api/http'
import { serviceUnavailableMessage } from '@/lib/api/serviceStatus'
import { TransferApi, PROPERTY_TYPES, type PropertyRecordApi } from '@/lib/api/transferApi'
import { useTransfer, PropertyDetails } from './TransferForm'
import { MatterPropertyLinks } from './MatterPropertiesPanel'

const StepProperty: React.FC = () => {
  const { state, dispatch } = useTransfer()
  const { propertyDetails } = state
  const location = useLocation()
  const goldenRecord = readNavigationState(location.state)?.goldenRecord

  // Auto-populate from golden record if available
  useEffect(() => {
    if (goldenRecord) {
      dispatch({
        type: 'UPDATE_PROPERTY_DETAILS',
        payload: {
          address: goldenRecord.propertyAddress || '',
          city: '',
          state: '',
          zipCode: '',
          propertyType: '',
          lotNumber: '',
          legalDescription: '',
          yearBuilt: '',
          squareFootage: ''
        }
      })
    }
  }, [goldenRecord, dispatch])

  const updatePropertyDetails = (field: keyof PropertyDetails, value: string) => {
    dispatch({
      type: 'UPDATE_PROPERTY_DETAILS',
      payload: { [field]: value }
    })
  }

  const [query, setQuery] = useState(propertyDetails.address)
  const [suggestions, setSuggestions] = useState<{ id: string; text: string; description?: string }[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | null>(null)
  const selectedRef = useRef<string | null>(null)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)

  useEffect(() => {
    setQuery(propertyDetails.address)
  }, [propertyDetails.address])

  useEffect(() => {
    if (searchTimeout.current) {
      clearTimeout(searchTimeout.current)
    }
    setSearchError('')

    if (!showSuggestions || !query.trim() || query === (selectedRef.current ?? '')) {
      setSuggestions([])
      return
    }

    if (query.trim().length < 3) {
      setSuggestions([])
      return
    }

    setIsSearching(true)
    searchTimeout.current = setTimeout(async () => {
      try {
        const response = await apiRequest<{ success: boolean; data: { Items?: Array<{ Id: string; Text: string; Description?: string }> } }>(
          `/api/address/search?text=${encodeURIComponent(query)}&country=ZA`
        )
        setSuggestions((response.data?.Items ?? []).map(item => ({
          id: item.Id,
          text: item.Text,
          description: item.Description
        })))
      } catch (err) {
        setSuggestions([])
        setSearchError(`${serviceUnavailableMessage('Address lookup', err)} You can still type the address manually.`)
      } finally {
        setIsSearching(false)
      }
    }, 400)

    return () => {
      if (searchTimeout.current) {
        clearTimeout(searchTimeout.current)
      }
    }
  }, [query, showSuggestions])

  useEffect(() => {
    if (!mapContainerRef.current || !coordinates) return

    if (!mapRef.current) {
      mapRef.current = L.map(mapContainerRef.current).setView([coordinates.lat, coordinates.lng], 16)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(mapRef.current)
    } else {
      mapRef.current.setView([coordinates.lat, coordinates.lng], 16)
    }

    if (markerRef.current) {
      markerRef.current.setLatLng([coordinates.lat, coordinates.lng])
    } else if (mapRef.current) {
      markerRef.current = L.marker([coordinates.lat, coordinates.lng]).addTo(mapRef.current)
    }

    return () => {
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
    }
  }, [coordinates])

  const handleSelectSuggestion = async (item: { id: string; text: string }) => {
    selectedRef.current = item.text
    setQuery(item.text)
    setShowSuggestions(false)
    setSuggestions([])
    setIsSearching(false)

    try {
      const response = await apiRequest<{ success: boolean; data: { Items?: Array<Record<string, string>> } }>(
        `/api/address/retrieve?id=${encodeURIComponent(item.id)}`
      )
      const result = response.data?.Items?.[0]
      if (result) {
        updatePropertyDetails('address', [result.Line1, result.Line2, result.Line3, result.Line4, result.Line5].filter(Boolean).join(', '))
        updatePropertyDetails('city', result.City || '')
        updatePropertyDetails('state', result.Province || result.ProvinceName || '')
        updatePropertyDetails('zipCode', result.PostalCode || '')
        await geocodeAddress(result)
      }
    } catch (err) {
      setSearchError(`${serviceUnavailableMessage('Address lookup', err)} You can still type the address manually.`)
    }
  }

  const geocodeAddress = async (address: Record<string, string>) => {
    const full = [address.Line1, address.City, address.Province || address.ProvinceName, address.PostalCode, 'South Africa']
      .filter(Boolean)
      .join(', ')
    if (!full) return
    try {
      const response = await apiRequest<{ success: boolean; data: Array<{ lat: string; lon: string; display_name: string }> }>(
        `/api/address/geocode?q=${encodeURIComponent(full)}`
      )
      const first = response.data?.[0]
      if (first) {
        setCoordinates({ lat: parseFloat(first.lat), lng: parseFloat(first.lon) })
      }
    } catch {
      setCoordinates(null)
    }
  }

  const handleAddressInputChange = (value: string) => {
    selectedRef.current = null
    setQuery(value)
    setShowSuggestions(true)
    updatePropertyDetails('address', value)
  }

  // Existing-property discovery: selecting a result links that property on
  // save instead of capturing a manual record. Only active properties are
  // selectable — the API enforces the same eligibility on link.
  const [propertySearch, setPropertySearch] = useState('')
  const [propertyResults, setPropertyResults] = useState<PropertyRecordApi[]>([])
  const [isPropertySearching, setIsPropertySearching] = useState(false)
  const [propertySearchCompleted, setPropertySearchCompleted] = useState(false)
  const [propertySearchError, setPropertySearchError] = useState('')
  const propertySearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const propertySearchVersion = useRef(0)

  const linkedOrSelected = Boolean(state.persistedPropertyLinkId || state.selectedPropertyId)

  useEffect(() => {
    const version = ++propertySearchVersion.current
    if (propertySearchTimeout.current) clearTimeout(propertySearchTimeout.current)
    setPropertySearchError('')
    setPropertyResults([])
    setIsPropertySearching(false)
    setPropertySearchCompleted(false)
    if (linkedOrSelected || propertySearch.trim().length < 3) return
    setIsPropertySearching(true)
    propertySearchTimeout.current = setTimeout(async () => {
      try {
        const response = await TransferApi.searchProperties(propertySearch.trim())
        if (version === propertySearchVersion.current) {
          setPropertyResults(response.data ?? [])
          setPropertySearchCompleted(true)
        }
      } catch (err) {
        if (version === propertySearchVersion.current) setPropertySearchError(serviceUnavailableMessage('Property search', err))
      } finally {
        if (version === propertySearchVersion.current) setIsPropertySearching(false)
      }
    }, 400)
    return () => {
      propertySearchVersion.current += 1
      if (propertySearchTimeout.current) clearTimeout(propertySearchTimeout.current)
    }
  }, [propertySearch, linkedOrSelected])

  const selectExistingProperty = (property: PropertyRecordApi) => {
    if (property.status !== 'active') return
    propertySearchVersion.current += 1
    setIsPropertySearching(false)
    dispatch({
      type: 'UPDATE_PROPERTY_LINK',
      payload: {
        selectedPropertyId: property.id,
        linkedProperty: {
          id: property.id,
          streetAddress: property.streetAddress || '',
          city: property.city || '',
          province: property.province || '',
          postalCode: property.postalCode || '',
          propertyType: property.propertyType || '',
          status: property.status || '',
          manual: property.manual
        }
      }
    })
    setPropertySearch('')
    setPropertyResults([])
  }

  const clearSelectedProperty = () => {
    dispatch({
      type: 'UPDATE_PROPERTY_LINK',
      payload: { selectedPropertyId: undefined, linkedProperty: undefined }
    })
  }

  const propertyTypes = [...PROPERTY_TYPES]

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-right-5 duration-500">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Property Details
        </h2>
        <p className="text-gray-600 dark:text-gray-400">
          Enter the property information for this transfer
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {Boolean(state.savedPropertyLinks?.length) && (
          <Card variant="premium" className="lg:col-span-2">
            <CardHeader><CardTitle>{state.savedPropertyLinks!.length === 1 ? 'Linked property' : 'Linked properties'}</CardTitle></CardHeader>
            <CardContent>
              <MatterPropertyLinks links={state.savedPropertyLinks!} />
              <p className="mt-2 text-xs text-gray-500">Saved links cannot be removed here; additional properties can be attached from the matter page.</p>
            </CardContent>
          </Card>
        )}
        {/* Linked / selected property */}
        {linkedOrSelected && state.linkedProperty && !state.savedPropertyLinks?.length && (
          <Card variant="premium" className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Link2 className="h-5 w-5 text-teal-600 dark:text-teal-400" />
                <span>{state.persistedPropertyLinkId ? 'Linked property' : 'Selected property'}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {state.linkedProperty.streetAddress || '—'}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {[state.linkedProperty.city, state.linkedProperty.province, state.linkedProperty.postalCode].filter(Boolean).join(', ')}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {state.linkedProperty.propertyType || '—'}
                    {state.linkedProperty.manual && (
                      <span className="ml-2 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                        Manually captured — unverified
                      </span>
                    )}
                  </p>
                </div>
                {!state.persistedPropertyLinkId && (
                  <button
                    type="button"
                    onClick={clearSelectedProperty}
                    className="inline-flex items-center space-x-1 rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-navy-600 dark:text-gray-300 dark:hover:bg-navy-700"
                  >
                    <X className="h-3 w-3" />
                    <span>Change</span>
                  </button>
                )}
              </div>
              {state.persistedPropertyLinkId && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Saved links cannot be removed here; additional properties can be attached from the matter page.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Existing property discovery */}
        {!linkedOrSelected && (
          <Card variant="premium" className="lg:col-span-2">
            <CardContent className="pt-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Link an existing property (optional)
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  variant="premium"
                  placeholder="Search your institution's properties by address, city, erf or reference..."
                  value={propertySearch}
                  onChange={(e) => { propertySearchVersion.current += 1; setPropertyResults([]); setPropertySearchCompleted(false); setPropertySearch(e.target.value) }}
                  className="pl-10 transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                />
              </div>
              {isPropertySearching && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Searching...</p>
              )}
              {propertySearchError && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">{propertySearchError}</p>
              )}
              {propertySearchCompleted && !isPropertySearching && !propertySearchError && propertyResults.length === 0 && (
                <p className="mt-2 text-sm text-gray-500">No matching properties.</p>
              )}
              {propertyResults.length > 0 && (
                <div className="mt-2 max-h-60 overflow-auto rounded-lg border border-gray-200 dark:border-navy-700">
                  {propertyResults.map((property) => (
                    <button
                      key={property.id}
                      type="button"
                      disabled={property.status !== 'active'}
                      onClick={() => selectExistingProperty(property)}
                      className="w-full text-left px-4 py-2 border-b border-gray-100 dark:border-navy-700 last:border-0 hover:bg-gray-50 dark:hover:bg-navy-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <p className="text-sm text-gray-900 dark:text-gray-100">
                        {property.streetAddress || property.propertyId || property.id}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {[property.city, property.province].filter(Boolean).join(', ')}
                        {property.propertyType ? ` · ${property.propertyType}` : ''}
                        {property.status && property.status !== 'active' ? ` · ${property.status} (not linkable)` : ''}
                        {property.manual ? ' · manual — unverified' : ''}
                      </p>
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Or capture a new property below. Manually captured properties are private to your institution and are not verified against any registry.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Address Information */}
        {!linkedOrSelected && (<>
        <Card variant="premium" className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <MapPin className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <span>Address Information</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Street Address *
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  variant="premium"
                  placeholder="Start typing the address..."
                  value={query}
                  onChange={(e) => handleAddressInputChange(e.target.value)}
                  onFocus={() => setShowSuggestions(true)}
                  className="pl-10 transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                />
              </div>

              {isSearching && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Searching...</p>
              )}
              {searchError && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">{searchError}</p>
              )}

              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute z-20 mt-1 w-full bg-white dark:bg-navy-800 border border-gray-200 dark:border-navy-700 rounded-lg shadow-lg max-h-60 overflow-auto">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); handleSelectSuggestion(suggestion) }}
                      className="w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-navy-700 border-b border-gray-100 dark:border-navy-700 last:border-0"
                    >
                      <p className="text-sm text-gray-900 dark:text-gray-100">{suggestion.text}</p>
                      {suggestion.description && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">{suggestion.description}</p>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {coordinates && (
                <div className="mt-4">
                  <div className="flex items-center space-x-2 mb-2">
                    <MapIcon className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Location</span>
                  </div>
                  <div ref={mapContainerRef} className="w-full h-64 rounded-lg border border-gray-200 dark:border-navy-700" />
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  City *
                </label>
                <Input
                  variant="premium"
                  placeholder="Santon"
                  value={propertyDetails.city}
                  onChange={(e) => updatePropertyDetails('city', e.target.value)}
                  className="transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Province *
                </label>
                <Input
                  variant="premium"
                  placeholder="Gouteng"
                  value={propertyDetails.state}
                  onChange={(e) => updatePropertyDetails('state', e.target.value)}
                  className="transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Postal code *
                </label>
                <Input
                  variant="premium"
                  placeholder="2196"
                  value={propertyDetails.zipCode}
                  onChange={(e) => updatePropertyDetails('zipCode', e.target.value)}
                  className="transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Property Information */}
        <Card variant="premium">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Building className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <span>Property Information</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Property Type *
              </label>
              <select
                value={propertyDetails.propertyType}
                onChange={(e) => updatePropertyDetails('propertyType', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-navy-600 rounded-lg bg-white dark:bg-navy-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition-all duration-200"
              >
                <option value="">Select property type</option>
                {propertyTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Erf number
              </label>
              <Input
                variant="premium"
                placeholder="Erf 1234"
                value={propertyDetails.lotNumber}
                onChange={(e) => updatePropertyDetails('lotNumber', e.target.value)}
                className="transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Year Built
              </label>
              <Input
                variant="premium"
                placeholder="2020"
                value={propertyDetails.yearBuilt}
                onChange={(e) => updatePropertyDetails('yearBuilt', e.target.value)}
                className="transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>

            {/* Area capture is deferred: the field stays visible so captured
                values are preserved, but it is not editable in this slice and
                is never written to square_footage or extent_sqm. */}
            <div>
              <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
                Area (m²)
              </label>
              <Input
                variant="premium"
                placeholder="Not available"
                value={propertyDetails.squareFootage}
                disabled
                readOnly
                className="opacity-60 cursor-not-allowed"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Area capture is unavailable in this step. Existing values are preserved unchanged.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Legal Description */}
        <Card variant="premium">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <FileText className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <span>Legal Description</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Legal Description
              </label>
              <textarea
                value={propertyDetails.legalDescription}
                onChange={(e) => updatePropertyDetails('legalDescription', e.target.value)}
                placeholder="Enter the legal description as it appears on the deed..."
                rows={6}
                className="w-full px-3 py-2 border border-gray-300 dark:border-navy-600 rounded-lg bg-white dark:bg-navy-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition-all duration-200 resize-none"
              />
            </div>
          </CardContent>
        </Card>
        </>)}
      </div>

      {/* Validation Summary */}
      <Card variant="glass">
        <CardContent className="p-4">
          <div className="flex items-center space-x-2">
            <Home className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Required fields marked with * must be completed
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export { StepProperty }
