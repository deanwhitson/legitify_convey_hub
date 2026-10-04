import React, { useEffect, useId, useRef, useState } from 'react'
import { Link2, Search } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent, Input, Button } from '@/components/ui'
import { TransferApi, PROPERTY_TYPES, buildManualPropertyRequest, type AttachMatterPropertyRequest, type MatterPropertyLinkApi, type PropertyRecordApi } from '@/lib/api/transferApi'
import { serviceUnavailableMessage } from '@/lib/api/serviceStatus'
import type { PropertyDetails } from './TransferForm'

const emptyDetails: PropertyDetails = {
  address: '', city: '', state: '', zipCode: '', propertyType: '',
  lotNumber: '', legalDescription: '', yearBuilt: '', squareFootage: ''
}

export const MatterPropertyLinks: React.FC<{ links: MatterPropertyLinkApi[] }> = ({ links }) => (
  <ul aria-label="Linked properties" className="divide-y divide-gray-200 dark:divide-navy-700">
    {links.map(link => (
      <li key={link.id} className="py-3">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {link.property?.streetAddress || link.externalPropertyId || link.propertyId || 'Linked property'}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {[link.property?.city, link.property?.province, link.property?.postalCode].filter(Boolean).join(', ')}
          {link.property?.propertyType ? ` · ${link.property.propertyType}` : ''}
          {link.property?.erfNumber ? ` · Erf ${link.property.erfNumber}` : ''}
          {link.property?.yearBuilt != null ? ` · Built ${link.property.yearBuilt}` : ''}
        </p>
        {link.property?.legalDescription && <p className="whitespace-pre-wrap text-xs text-gray-500">{link.property.legalDescription}</p>}
        {link.property?.manual && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
            Manually captured — unverified
          </span>
        )}
        {link.property?.status && link.property.status !== 'active' && (
          <span className="ml-2 text-xs text-gray-500">{link.property.status}</span>
        )}
        {link.propertyKind === 'output' && <span className="ml-2 text-xs text-gray-500">output</span>}
      </li>
    ))}
  </ul>
)

/**
 * Saved matter–property links plus attach-existing via discovery.
 *
 * The list always renders server readback — never optimistic local state —
 * so a failed attach leaves nothing displayed that was not persisted.
 * Existing links remain readable regardless of the property's current
 * status; only active properties are offered as new link targets. Manual
 * captures are labelled unverified; no verification is inferred from
 * external identifiers.
 */
const MatterPropertiesEditor: React.FC<{ transferId: string }> = ({ transferId }) => {
  const [links, setLinks] = useState<MatterPropertyLinkApi[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isAttaching, setIsAttaching] = useState(false)
  const [isCapturing, setIsCapturing] = useState(false)
  const [details, setDetails] = useState<PropertyDetails>(emptyDetails)
  const [searchText, setSearchText] = useState('')
  const [results, setResults] = useState<PropertyRecordApi[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchCompleted, setSearchCompleted] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [pendingPropertyId, setPendingPropertyId] = useState<string | null>(null)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = useRef(true)
  const loadVersion = useRef(0)
  const searchVersion = useRef(0)
  const mutationPending = useRef(false)
  const attachKeys = useRef(new Map<string, string>())
  const captureKey = useRef<string | null>(null)
  const formId = useId()

  const load = async () => {
    const version = ++loadVersion.current
    setIsLoading(true)
    setLoadError(null)
    try {
      const response = await TransferApi.getMatterProperties(transferId)
      if (!active.current || version !== loadVersion.current) return false
      setLinks(response.data ?? [])
      return true
    } catch (err) {
      if (active.current && version === loadVersion.current) setLoadError(serviceUnavailableMessage('Linked properties', err))
      return false
    } finally {
      if (active.current && version === loadVersion.current) setIsLoading(false)
    }
  }

  useEffect(() => {
    active.current = true
    void load()
    return () => {
      active.current = false
      loadVersion.current += 1
      searchVersion.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferId])

  useEffect(() => {
    const version = ++searchVersion.current
    setResults([])
    setIsSearching(false)
    setSearchCompleted(false)
    setSearchError(null)
    if (!isAttaching || searchText.trim().length < 3) return
    setIsSearching(true)
    searchTimeout.current = setTimeout(async () => {
      try {
        const response = await TransferApi.searchProperties(searchText.trim())
        if (active.current && version === searchVersion.current) {
          setResults(response.data ?? [])
          setSearchCompleted(true)
        }
      } catch (err) {
        if (active.current && version === searchVersion.current) setSearchError(serviceUnavailableMessage('Property search', err))
      } finally {
        if (active.current && version === searchVersion.current) setIsSearching(false)
      }
    }, 400)
    return () => {
      searchVersion.current += 1
      if (searchTimeout.current) clearTimeout(searchTimeout.current)
    }
  }, [searchText, isAttaching])

  const save = async (request: AttachMatterPropertyRequest, propertyId: string) => {
    if (mutationPending.current || isLoading || loadError) return
    mutationPending.current = true
    setPendingPropertyId(propertyId)
    setAttachError(null)
    setSaveNotice(null)
    try {
      const response = await TransferApi.attachMatterProperty(transferId, request)
      if (!active.current) return
      if (!response.data?.id) throw new Error('The property save could not be confirmed. Retry with the same entries.')
      setIsAttaching(false)
      setIsCapturing(false)
      setSearchText('')
      setResults([])
      setDetails(emptyDetails)
      captureKey.current = null
      const refreshed = await load()
      if (active.current) setSaveNotice(refreshed ? 'Property saved.' : 'Property saved, but readback failed. Retry loading linked properties; do not resubmit the save.')
    } catch (err) {
      // Honest failure: the link list stays as last read back from the server.
      if (active.current) setAttachError(err instanceof Error ? err.message : 'The property could not be linked.')
    } finally {
      mutationPending.current = false
      if (active.current) setPendingPropertyId(null)
    }
  }

  const attach = async (property: PropertyRecordApi) => {
    if (property.status !== 'active' || mutationPending.current || links.some(link => link.propertyKind === 'input' && link.propertyId === property.id)) return
    // A fresh key per user-initiated attach; a retried click after a failed
    // request reuses pendingPropertyId's request only on resubmit of the
    // same action — the server deduplicates identical replays anyway.
    const key = attachKeys.current.get(property.id) || crypto.randomUUID()
    attachKeys.current.set(property.id, key)
    await save({ client_request_id: key, property_id: property.id }, property.id)
  }

  const capture = async () => {
    setAttachError(null)
    if (!details.zipCode.trim()) {
      setAttachError('Postal code is required')
      return
    }
    const key = captureKey.current || crypto.randomUUID()
    const request = buildManualPropertyRequest(details, key)
    if ('error' in request) {
      setAttachError(request.error)
      return
    }
    captureKey.current = key
    await save(request, 'manual')
  }

  const cancel = () => {
    searchVersion.current += 1
    setIsAttaching(false)
    setIsCapturing(false)
    setSearchText('')
    setResults([])
    setAttachError(null)
    setDetails(emptyDetails)
    captureKey.current = null
  }

  const fields: [keyof PropertyDetails, string][] = [
    ['address', 'Street address *'], ['city', 'City *'], ['state', 'Province *'],
    ['zipCode', 'Postal code *'], ['lotNumber', 'Erf number'],
    ['legalDescription', 'Legal description'], ['yearBuilt', 'Year built']
  ]

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center space-x-2">
            <Link2 className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            <span>Linked Properties</span>
          </CardTitle>
          {!isAttaching && !isCapturing && !loadError && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={isLoading || pendingPropertyId !== null} onClick={() => { setSaveNotice(null); setIsAttaching(true) }}>
                Attach existing property
              </Button>
              <Button variant="outline" size="sm" disabled={isLoading || pendingPropertyId !== null} onClick={() => { setSaveNotice(null); setIsCapturing(true) }}>
                Capture a property
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading linked properties...</p>}
        {loadError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}
        {saveNotice && <p role="status" className="mb-2 text-sm">{saveNotice}</p>}
        {!isLoading && !loadError && links.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">No properties are linked to this matter yet.</p>
        )}
        {!isLoading && !loadError && links.length > 0 && <MatterPropertyLinks links={links} />}
        {!isLoading && (
          <Button variant="outline" size="sm" disabled={pendingPropertyId !== null} onClick={() => { void load().then(ok => { if (ok && active.current) setSaveNotice(null) }) }}>
            {loadError ? 'Retry loading linked properties' : 'Refresh linked properties'}
          </Button>
        )}
        {isAttaching && (
          <div className="mt-4 border-t border-gray-200 pt-4 dark:border-navy-700">
            <label htmlFor={`${formId}-search`} className="block text-xs font-medium mb-2">Search your institution's properties</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input id={`${formId}-search`} variant="premium" placeholder="Address, city, erf or reference..." value={searchText}
                disabled={pendingPropertyId !== null}
                onChange={event => { searchVersion.current += 1; setResults([]); setSearchCompleted(false); setSearchText(event.target.value) }} className="pl-10" />
            </div>
            {isSearching && <p className="mt-2 text-xs text-gray-500">Searching...</p>}
            {searchError && <p role="alert" className="mt-2 text-xs text-red-600">{searchError}</p>}
            {searchCompleted && !isSearching && !searchError && searchText.trim().length >= 3 && results.length === 0 && <p className="mt-2 text-sm">No matching properties.</p>}
            {results.length > 0 && (
              <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-gray-200 dark:border-navy-700">
                {results.map(property => {
                  const alreadyLinked = links.some(link => link.propertyKind === 'input' && link.propertyId === property.id)
                  return (
                    <button key={property.id} type="button" disabled={alreadyLinked || property.status !== 'active' || pendingPropertyId !== null || isLoading || Boolean(loadError)}
                      onClick={() => { void attach(property) }}
                      className="w-full border-b border-gray-100 px-4 py-2 text-left last:border-0 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-navy-700 dark:hover:bg-navy-700">
                      <p className="text-sm">{property.streetAddress || property.propertyId || property.id}</p>
                      <p className="text-xs text-gray-500">
                        {[property.city, property.province].filter(Boolean).join(', ')}
                        {property.propertyType ? ` · ${property.propertyType}` : ''}
                        {property.status !== 'active' ? ` · ${property.status || 'unknown status'} (not linkable)` : ''}
                        {property.manual ? ' · manual — unverified' : ''}
                        {alreadyLinked ? ' · Already linked' : ''}
                      </p>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {isCapturing && (
          <form aria-label="Capture property" className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void capture() }}>
            <p className="text-sm">Manually captured properties are private to your institution and unverified. Area capture is unavailable.</p>
            {fields.map(([field, label]) => (
              <div key={field}>
                <label htmlFor={`${formId}-${field}`} className="block text-sm">{label}</label>
                {field === 'legalDescription' ? (
                  <textarea id={`${formId}-${field}`} rows={3} value={details[field]} disabled={pendingPropertyId !== null}
                    className="w-full rounded border p-2 dark:bg-navy-700"
                    onChange={event => setDetails(current => ({ ...current, [field]: event.target.value }))} />
                ) : (
                  <Input id={`${formId}-${field}`} value={details[field]} disabled={pendingPropertyId !== null}
                    onChange={event => setDetails(current => ({ ...current, [field]: event.target.value }))} />
                )}
              </div>
            ))}
            <label htmlFor={`${formId}-type`} className="block text-sm">Property type *</label>
            <select id={`${formId}-type`} value={details.propertyType} disabled={pendingPropertyId !== null}
              onChange={event => setDetails(current => ({ ...current, propertyType: event.target.value }))}
              className="w-full rounded border p-2 dark:bg-navy-700">
              <option value="">Select property type</option>
              {PROPERTY_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
            </select>
            <Button type="submit" disabled={pendingPropertyId !== null || isLoading || Boolean(loadError)}>Save property</Button>
          </form>
        )}
        {attachError && <p role="alert" className="mt-2 text-sm text-red-600">{attachError}</p>}
        {(isAttaching || isCapturing) && (
          <div className="mt-3 flex justify-end"><Button variant="outline" size="sm" disabled={pendingPropertyId !== null} onClick={cancel}>Cancel</Button></div>
        )}
      </CardContent>
    </Card>
  )
}

const MatterPropertiesPanel: React.FC<{ transferId: string }> = ({ transferId }) => (
  <MatterPropertiesEditor key={transferId} transferId={transferId} />
)

export { MatterPropertiesPanel }
