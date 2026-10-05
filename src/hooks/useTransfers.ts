import { useState, useCallback, useRef, useEffect } from 'react'
import { TransferApi, TransferAggregate, TransferListResponse, TransferStatusTotals, Milestone, AuditEntry } from '../lib/api/transferApi'
import { TransferFilters } from '../lib/types'

export type { TransferAggregate, Milestone, AuditEntry }

export interface TransfersState {
  transfers: TransferAggregate[]
  statusTotals: TransferStatusTotals | null
  pagination: TransferListResponse['pagination'] | null
  currentTransfer: TransferAggregate | null
  currentMilestones: Milestone[]
  activity: AuditEntry[]
  isMilestonesLoading: boolean
  milestonesError: string | null
  isActivityLoading: boolean
  activityError: string | null
  isLoading: boolean
  error: string | null
}

export const useTransfers = () => {
  const listRequest = useRef(0)
  const transferRequest = useRef(0)
  const milestonesRequest = useRef(0)
  const activityRequest = useRef(0)
  useEffect(() => () => {
    listRequest.current += 1
    transferRequest.current += 1
    milestonesRequest.current += 1
    activityRequest.current += 1
  }, [])
  const [state, setState] = useState<TransfersState>({
    transfers: [],
    statusTotals: null,
    pagination: null,
    currentTransfer: null,
    currentMilestones: [],
    activity: [],
    isMilestonesLoading: true,
    milestonesError: null,
    isActivityLoading: true,
    activityError: null,
    isLoading: false,
    error: null
  })

  const setLoading = useCallback((loading: boolean) => {
    setState(prev => ({ ...prev, isLoading: loading, error: null }))
  }, [])

  const setError = useCallback((error: string) => {
    setState(prev => ({ ...prev, isLoading: false, error }))
  }, [])

  // Fetch list of transfers
  const fetchTransfers = useCallback(async (filters: TransferFilters = {}) => {
    const request = ++listRequest.current
    setState(prev => ({ ...prev, transfers: [], pagination: null, statusTotals: null, isLoading: true, error: null }))
    try {
      const response = await TransferApi.getTransfers(filters)
      if (request !== listRequest.current) return
      if (response.success && response.data) {
        setState(prev => ({
          ...prev,
          transfers: response.data!,
          pagination: response.pagination,
          statusTotals: response.statusTotals,
          isLoading: false,
          error: null
        }))
      } else {
        setError(response.error || 'Failed to fetch transfers')
      }
    } catch (error) {
      if (request === listRequest.current) {
        setError(error instanceof Error ? error.message : 'An unexpected error occurred')
      }
    }
  }, [setError])

  // Fetch a single transfer aggregate
  const fetchTransfer = useCallback(async (id: string) => {
    const request = ++transferRequest.current
    setState(prev => ({ ...prev, currentTransfer: null, isLoading: true, error: null }))
    try {
      const response = await TransferApi.getTransfer(id)
      if (request !== transferRequest.current) return null
      if (response.success && response.data) {
        setState(prev => ({
          ...prev,
          currentTransfer: response.data || null,
          isLoading: false,
          error: null
        }))
        return response.data
      } else {
        setError(response.error || 'Transfer not found')
        return null
      }
    } catch (error) {
      if (request === transferRequest.current) setError(error instanceof Error ? error.message : 'An unexpected error occurred')
      return null
    }
  }, [setError])

  // Create a new transfer from an aggregate workflow state
  const createTransfer = useCallback(async (data: Partial<TransferAggregate> | { property_address: string; purchase_price: number }) => {
    setLoading(true)
    try {
      const response = await TransferApi.createTransfer(data as any)
      if (response.success && response.data) {
        setState(prev => ({
          ...prev,
          transfers: [response.data!, ...prev.transfers],
          currentTransfer: response.data!,
          isLoading: false,
          error: null
        }))
        return response.data
      } else {
        setError(response.error || 'Failed to create transfer')
        return null
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An unexpected error occurred')
      return null
    }
  }, [setLoading, setError])

  // Update a transfer aggregate
  const updateTransfer = useCallback(async (id: string, data: Partial<TransferAggregate>) => {
    setLoading(true)
    try {
      const response = await TransferApi.updateTransfer(id, data)
      if (response.success && response.data) {
        setState(prev => ({
          ...prev,
          transfers: prev.transfers.map(t => t.id === id || t.transfer_id === id ? response.data! : t),
          currentTransfer: prev.currentTransfer && (prev.currentTransfer.id === id || prev.currentTransfer.transfer_id === id)
            ? response.data!
            : prev.currentTransfer,
          isLoading: false,
          error: null
        }))
        return response.data
      } else {
        setError(response.error || 'Failed to update transfer')
        return null
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An unexpected error occurred')
      return null
    }
  }, [setLoading, setError])

  // Delete a transfer
  const deleteTransfer = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const response = await TransferApi.deleteTransfer(id)
      if (response.success) {
        setState(prev => ({
          ...prev,
          transfers: prev.transfers.filter(t => t.id !== id && t.transfer_id !== id),
          currentTransfer: prev.currentTransfer && (prev.currentTransfer.id === id || prev.currentTransfer.transfer_id === id)
            ? null
            : prev.currentTransfer,
          isLoading: false,
          error: null
        }))
        return true
      } else {
        setError(response.error || 'Failed to delete transfer')
        return false
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An unexpected error occurred')
      return false
    }
  }, [setLoading, setError])

  // Fetch milestones for a transfer
  const fetchMilestones = useCallback(async (id: string) => {
    const request = ++milestonesRequest.current
    setState(prev => ({ ...prev, currentMilestones: [], isMilestonesLoading: true, milestonesError: null }))
    try {
      const response = await TransferApi.getMilestones(id)
      if (request !== milestonesRequest.current) return
      if (!response.success || !response.data) throw new Error('Milestones are temporarily unavailable')
      setState(prev => ({ ...prev, currentMilestones: response.data!, isMilestonesLoading: false, milestonesError: null }))
    } catch (error) {
      if (request === milestonesRequest.current) setState(prev => ({ ...prev, isMilestonesLoading: false,
        milestonesError: error instanceof Error ? error.message : 'Milestones are temporarily unavailable' }))
    }
  }, [])

  // Update milestones for a transfer
  const updateMilestones = useCallback(async (_id: string, _milestones: Milestone[]) => {
    setState(prev => ({ ...prev, milestonesError: 'Milestones are read-only; editing is unavailable.' }))
    return null
  }, [])

  // Fetch activity/audit trail for a transfer
  const fetchActivity = useCallback(async (id: string) => {
    const request = ++activityRequest.current
    setState(prev => ({ ...prev, activity: [], isActivityLoading: true, activityError: null }))
    try {
      const response = await TransferApi.getActivity(id)
      if (request !== activityRequest.current) return
      if (!response.success || !response.data) throw new Error('Transfer activity is temporarily unavailable')
      setState(prev => ({ ...prev, activity: response.data!, isActivityLoading: false, activityError: null }))
    } catch (error) {
      if (request === activityRequest.current) setState(prev => ({ ...prev, isActivityLoading: false,
        activityError: error instanceof Error ? error.message : 'Transfer activity is temporarily unavailable' }))
    }
  }, [])

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }))
  }, [])

  return {
    ...state,
    fetchTransfers,
    fetchTransfer,
    createTransfer,
    updateTransfer,
    deleteTransfer,
    fetchMilestones,
    updateMilestones,
    fetchActivity,
    clearError
  }
}
