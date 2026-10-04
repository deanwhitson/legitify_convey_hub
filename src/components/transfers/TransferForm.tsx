import React, { createContext, useContext, useReducer, ReactNode } from 'react'
import { calculateTotalTransferCosts, formatZAR } from '@/utils/transferCalculations'
import type { GoldenRecordEntityType } from '@/lib/api/goldenRecordsApi'
import type { MatterPropertyLinkApi } from '@/lib/api/transferApi'

// Types
export interface PropertyDetails {
  address: string
  city: string
  state: string
  zipCode: string
  propertyType: string
  lotNumber: string
  legalDescription: string
  yearBuilt: string
  squareFootage: string
}

export type PartySource = 'manual' | 'golden_record'

export interface Party {
  id: string
  /** Explicit capture source. 'manual' = institution-captured matter data;
   * 'golden_record' = linked Golden Record. Immutable once set. */
  source: PartySource
  goldenRecordId?: string
  entityType?: GoldenRecordEntityType
  registrationNo?: string | null
  mastersOffice?: string | null
  isTrust?: boolean
  type: 'buyer' | 'seller'
  name: string
  idNumber: string // SA ID number, passport number or company registration number
  /** Identifier kind so duplicate warnings compare like types only. */
  idType?: 'sa_id' | 'passport' | 'other'
  /** ISO country for passport identifiers; captured only where available. */
  passportCountry?: string
  email: string
  phone: string
  address: string
  company?: string
  role?: string
  isPrimary?: boolean // For marking primary buyer/seller
  /** Idempotency key generated when the party is added; reused on save retries. */
  clientRequestId?: string
  /** True when the user explicitly kept a flagged possible duplicate. */
  acknowledgedDuplicate?: boolean
  /** Server transfer_parties row id once attached; set after a successful save. */
  persistedPartyId?: string
}

export interface Financials {
  purchasePrice: string
  depositAmount: string
  loanAmount: string
  interestRate: string
  loanTerm: string
  // SA-specific fields
  transferDuty: string
  conveyancingFees: string
  deedsOfficeFees: string
  vat: string
  postPetty: string
  clearanceCertificate: string
  ratesClearance: string
}

export interface Document {
  id: string
  name: string
  type: string
  catalogueDocumentId?: string
  status: 'pending' | 'uploaded' | 'verified' | 'rejected' | 'not_required'
  uploadDate?: string
  file?: File
  description?: string
  notes?: string
  filePath?: string
  fileSize?: number
  fileType?: string
  originalFileName?: string
}

/** Display summary for a property selected via discovery or already linked
 * to the matter — enough to render the linked-property card read-only. */
export interface LinkedPropertySummary {
  id?: string
  streetAddress?: string
  city?: string
  province?: string
  postalCode?: string
  propertyType?: string
  status?: string
  /** True only for institution-private manual capture — never verified. */
  manual?: boolean
}

export interface TransferState {
  id?: string
  transfer_id?: string
  classificationCode?: string | null
  firmReference?: string | null
  currentStep: number
  propertyDetails: PropertyDetails
  /** An existing same-institution property chosen in Step 1 to link on save. */
  selectedPropertyId?: string
  /** Summary of the selected/saved property for read-only display. */
  linkedProperty?: LinkedPropertySummary
  /** Server matter_properties row id once the link is persisted. */
  persistedPropertyLinkId?: string
  /** Stable idempotency key for the property attach; reused on retries. */
  propertyRequestId?: string
  savedPropertyLinks?: MatterPropertyLinkApi[]
  parties: Party[]
  financials: Financials
  documents: Document[]
  status: 'draft' | 'in_progress' | 'completed'
}

// Initial state
const initialState: TransferState = {
  currentStep: 1,
  propertyDetails: {
    address: '',
    city: '',
    state: '',
    zipCode: '',
    propertyType: '',
    lotNumber: '',
    legalDescription: '',
    yearBuilt: '',
    squareFootage: ''
  },
  parties: [],
  financials: {
    purchasePrice: '',
    depositAmount: '',
    loanAmount: '',
    interestRate: '',
    loanTerm: '',
    // SA-specific fields
    transferDuty: '',
    conveyancingFees: '',
    deedsOfficeFees: '',
    vat: '',
    postPetty: '',
    clearanceCertificate: '',
    ratesClearance: ''
  },
  documents: [],
  status: 'draft'
}

// Action types
type TransferAction =
  | { type: 'SET_CURRENT_STEP'; payload: number }
  | { type: 'UPDATE_MATTER_DETAILS'; payload: Pick<TransferState, 'classificationCode' | 'firmReference'> }
  | { type: 'UPDATE_PROPERTY_DETAILS'; payload: Partial<PropertyDetails> }
  | { type: 'ADD_PARTY'; payload: Party }
  | { type: 'UPDATE_PARTY'; payload: { id: string; updates: Partial<Party> } }
  | { type: 'REMOVE_PARTY'; payload: string }
  | { type: 'UPDATE_FINANCIALS'; payload: Partial<Financials> }
  | { type: 'ADD_DOCUMENT'; payload: Document }
  | { type: 'UPDATE_DOCUMENT'; payload: { id: string; updates: Partial<Document> } }
  | { type: 'REMOVE_DOCUMENT'; payload: string }
  | { type: 'SET_DOCUMENTS'; payload: Document[] }
  | { type: 'SET_STATUS'; payload: 'draft' | 'in_progress' | 'completed' }
  | { type: 'SET_TRANSFER_ID'; payload: { id?: string; transfer_id?: string } }
  | { type: 'UPDATE_PROPERTY_LINK'; payload: Pick<TransferState, 'selectedPropertyId' | 'linkedProperty' | 'persistedPropertyLinkId' | 'propertyRequestId' | 'savedPropertyLinks'> }
  | { type: 'HYDRATE_TRANSFER'; payload: TransferState }
  | { type: 'RESET_FORM' }

// Reducer
const transferReducer = (state: TransferState, action: TransferAction): TransferState => {
  switch (action.type) {
    case 'SET_CURRENT_STEP':
      return { ...state, currentStep: action.payload }

    case 'UPDATE_MATTER_DETAILS':
      return state.id ? state : { ...state, ...action.payload }
    
    case 'UPDATE_PROPERTY_DETAILS':
      return {
        ...state,
        propertyDetails: { ...state.propertyDetails, ...action.payload }
      }
    
    case 'ADD_PARTY':
      return {
        ...state,
        parties: [...state.parties, action.payload]
      }
    
    case 'UPDATE_PARTY':
      return {
        ...state,
        parties: state.parties.map(party =>
          party.id === action.payload.id
            ? { ...party, ...action.payload.updates }
            : party
        )
      }
    
    case 'REMOVE_PARTY':
      return {
        ...state,
        parties: state.parties.filter(party => party.id !== action.payload)
      }
    
    case 'UPDATE_FINANCIALS':
      return {
        ...state,
        financials: { ...state.financials, ...action.payload }
      }
    
    case 'ADD_DOCUMENT':
      return {
        ...state,
        documents: [...state.documents, action.payload]
      }
    
    case 'UPDATE_DOCUMENT':
      return {
        ...state,
        documents: state.documents.map(doc =>
          doc.id === action.payload.id
            ? { ...doc, ...action.payload.updates }
            : doc
        )
      }
    
    case 'REMOVE_DOCUMENT':
      return {
        ...state,
        documents: state.documents.filter(doc => doc.id !== action.payload)
      }

    case 'SET_DOCUMENTS':
      return { ...state, documents: action.payload }

    case 'SET_STATUS':
      return {
        ...state,
        status: action.payload
      }

    case 'SET_TRANSFER_ID':
      return {
        ...state,
        id: action.payload.id,
        transfer_id: action.payload.transfer_id
      }

    case 'UPDATE_PROPERTY_LINK':
      return {
        ...state,
        ...action.payload
      }

    case 'HYDRATE_TRANSFER':
      return {
        ...initialState,
        ...action.payload
      }

    case 'RESET_FORM':
      return initialState
    
    default:
      return state
  }
}

// Context
const TransferContext = createContext<{
  state: TransferState
  dispatch: React.Dispatch<TransferAction>
} | null>(null)

// Provider. initialValue seeds state for tests/server rendering only —
// production mounts omit it.
export const TransferProvider: React.FC<{ children: ReactNode; initialValue?: TransferState }> = ({ children, initialValue }) => {
  const [state, dispatch] = useReducer(transferReducer, initialValue ?? initialState)

  return (
    <TransferContext.Provider value={{ state, dispatch }}>
      {children}
    </TransferContext.Provider>
  )
}

// Hook
export const useTransfer = () => {
  const context = useContext(TransferContext)
  if (!context) {
    throw new Error('useTransfer must be used within a TransferProvider')
  }
  return context
}

// Validation functions
export const validatePropertyDetails = (details: PropertyDetails, linked = false): boolean => {
  // A saved or selected link satisfies the step; manual capture requires the
  // DB floor (street/city/province/property_type) plus the UI-required code.
  return linked || !!(details.address && details.city && details.state && details.zipCode && details.propertyType)
}

export const validateParties = (parties: Party[]): boolean => {
  return parties.length >= 2 && 
         parties.some(p => p.type === 'buyer') && 
         parties.some(p => p.type === 'seller') &&
         parties.every(p => p.name && p.email && p.idNumber && p.phone)
}

export const validateFinancials = (financials: Financials): boolean => {
  return !!(financials.purchasePrice && financials.depositAmount)
}

export const validateDocuments = (documents: Document[]): boolean => {
  return documents.length > 0 && documents.every(doc =>
    doc.status === 'uploaded' || doc.status === 'not_required'
  )
}

export const calculateTransferCosts = (financials: Financials): {
  totalCosts: number
  netProceeds: number
  transferTaxRate: number
} => {
  const purchasePrice = parseFloat(financials.purchasePrice) || 0
  const transferDuty = parseFloat(financials.transferDuty) || 0
  const conveyancingFees = parseFloat(financials.conveyancingFees) || 0
  const deedsOfficeFees = parseFloat(financials.deedsOfficeFees) || 0
  const vat = parseFloat(financials.vat) || 0
  const postPetty = parseFloat(financials.postPetty) || 0
  const clearanceCertificate = parseFloat(financials.clearanceCertificate) || 0
  const ratesClearance = parseFloat(financials.ratesClearance) || 0

  const totalCosts = transferDuty + conveyancingFees + deedsOfficeFees + vat + postPetty + clearanceCertificate + ratesClearance
  const netProceeds = purchasePrice - totalCosts
  const transferTaxRate = purchasePrice > 0 ? (transferDuty / purchasePrice) * 100 : 0

  return {
    totalCosts,
    netProceeds,
    transferTaxRate
  }
}

export const getProgressPercentage = (state: TransferState): number => {
  const steps = 5
  const completedSteps = [
    validatePropertyDetails(state.propertyDetails, Boolean(state.persistedPropertyLinkId || state.selectedPropertyId)),
    validateParties(state.parties),
    validateFinancials(state.financials),
    validateDocuments(state.documents),
    state.currentStep === 5
  ].filter(Boolean).length

  return (completedSteps / steps) * 100
}

// SA-specific calculation functions
export const calculateSATransferCosts = (purchasePrice: string): {
  transferDuty: number
  conveyancingFees: number
  deedsOfficeFees: number
  vat: number
  postPetty: number
  clearanceCertificate: number
  ratesClearance: number
  totalCosts: number
  effectiveRate: number
} => {
  const price = parseFloat(purchasePrice) || 0
  const costs = calculateTotalTransferCosts(price)
  
  return {
    transferDuty: costs.transferCosts.transferDuty,
    conveyancingFees: costs.transferCosts.conveyancingFees,
    deedsOfficeFees: costs.transferCosts.deedsOfficeFees,
    vat: costs.additionalCosts.vat,
    postPetty: costs.additionalCosts.postPetty,
    clearanceCertificate: costs.additionalCosts.clearanceCertificate,
    ratesClearance: costs.additionalCosts.ratesClearance,
    totalCosts: costs.grandTotal,
    effectiveRate: costs.effectiveRate
  }
}

export const formatCurrency = (amount: string | number): string => {
  const num = typeof amount === 'string' ? parseFloat(amount) || 0 : amount
  return formatZAR(num)
}
