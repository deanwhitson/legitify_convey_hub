import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Database, FileDown, FileText, FileType2, GitBranch, History, Layers, Wand2 } from 'lucide-react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, UnavailableNotice } from '@/components/ui'
import { INITIAL_CLAUSES, LegalClause } from '@/lib/clauseLibrary'
import { generateDocxDocument, generatePdfDocument } from '@/lib/documentGenerator'
import { MatterTemplateData, resolveTemplate } from '@/lib/templateEngine'
import { apiRequest } from '@/lib/api/http'
import { useAuth } from '@/hooks/useAuth'
import { sessionUserDisplayName } from '@/lib/sessionIdentity'

const TRANSFER_TEMPLATE = `AGREEMENT OF SALE

Matter reference: {{Matter.ReferenceNumber}}
Property: {{Property.Address}} (ERF {{Property.ERF}})
Seller: {{Seller.FullName}}
Purchaser: {{Purchaser.FullName}}

{{Clause:transfer-purchase-price}}

{{Clause:occupation}}

Signed for and on behalf of {{Firm.Name}}.`

const TRANSFER_DATA: MatterTemplateData = {
  Purchaser: { FullName: 'John Smith', IDNumber: '8501015009087' },
  Seller: { FullName: 'Jane Doe', IDNumber: '7902025009088' },
  Property: { Address: '123 Main Street, Cape Town', ERF: '1234', Description: 'Erf 1234 Cape Town', Municipality: 'City of Cape Town' },
  Transfer: { PurchasePrice: 2500000, OccupationDate: '2026-08-01', TransactionDate: '2026-07-16' },
  Firm: { Name: 'Legitify Conveyancing' },
  Matter: { ReferenceNumber: 'TRF-001' }
}

const PIPELINE_STEPS = [
  { name: 'Matter', detail: 'TRF-001' },
  { name: 'Golden Records / Transfers', detail: 'Transfer record loaded' },
  { name: 'Rule Engine', detail: 'Required fields and clauses checked' },
  { name: 'Template', detail: 'Agreement of Sale v2.1' },
  { name: 'Merge Data', detail: 'Dictionary fields and clauses resolved' },
  { name: 'Generated Document', detail: 'Ready to download' }
]

interface GenerationHistoryEntry {
  documentId: string
  fileName: string
  templateVersion: string
  clauseVersions: string[]
  generatedDate: string
  matterId: string
  generatorVersion: string
  format: 'DOCX' | 'PDF'
  actor: string
}

const DocumentGenerator: React.FC = () => {
  const [format, setFormat] = useState<'docx' | 'pdf'>('docx')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [generationMessage, setGenerationMessage] = useState('')
  const { user } = useAuth()
  const [generationHistory, setGenerationHistory] = useState<GenerationHistoryEntry[]>([])
  const [clauses, setClauses] = useState<LegalClause[]>([])
  const [clausesOffline, setClausesOffline] = useState(false)
  const [historyError, setHistoryError] = useState('')

  const loadClauses = async () => {
    try {
      const data = await apiRequest<LegalClause[]>('/api/clauses')
      setClauses(data)
      setClausesOffline(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clause library')
      setClauses(INITIAL_CLAUSES)
      setClausesOffline(true)
    }
  }

  const loadHistory = async () => {
    try {
      const data = await apiRequest<GenerationHistoryEntry[]>('/api/generated-documents')
      setGenerationHistory(data)
      setHistoryError('')
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Generated document history is temporarily unavailable.')
    }
  }

  useEffect(() => {
    const initialise = async () => {
      setIsLoading(true)
      await Promise.all([loadClauses(), loadHistory()])
      setIsLoading(false)
    }
    initialise()
  }, [])

  const resolution = useMemo(() => resolveTemplate(TRANSFER_TEMPLATE, TRANSFER_DATA, clauses), [clauses])
  const canGenerate = !resolution.unresolvedFields.length && !resolution.undefinedFields.length && !resolution.unresolvedClauses.length

  const recordGeneratedDocument = async (entry: GenerationHistoryEntry) => {
    try {
      await apiRequest<GenerationHistoryEntry>('/api/generated-documents', { method: 'POST', body: entry })
      await loadHistory()
    } catch (err) {
      setHistoryError('The local generation metadata could not be saved — the document service is temporarily unavailable.')
    }
  }

  const generateDocument = async () => {
    if (!canGenerate) return
    setIsGenerating(true)
    setGenerationMessage('')
    setError('')
    const request = {
      template: TRANSFER_TEMPLATE,
      templateVersion: '2.1',
      matterData: TRANSFER_DATA,
      clauses,
      fileName: 'DEMO-TRF-001-agreement-of-sale',
      generatedBy: sessionUserDisplayName(user),
      notice: 'DEMO — synthetic data, not for transaction use'
    }

    try {
      const generatedDocument = format === 'docx'
        ? await generateDocxDocument(request)
        : generatePdfDocument(request)
      const generationEvent = generatedDocument.metadata.generationEvents[0]
      const entry: GenerationHistoryEntry = {
        documentId: generatedDocument.metadata.documentId,
        fileName: generatedDocument.fileName,
        templateVersion: generatedDocument.metadata.templateVersion,
        clauseVersions: generatedDocument.metadata.clauseVersions,
        generatedDate: generatedDocument.metadata.generatedDate,
        matterId: generatedDocument.metadata.matterId,
        generatorVersion: generatedDocument.metadata.generatorVersion,
        format: generationEvent.format,
        actor: generationEvent.actor
      }
      setGenerationHistory(previous => [entry, ...previous])
      void recordGeneratedDocument(entry)
      setGenerationMessage(`${format.toUpperCase()} document generated locally and downloaded. It is not saved to the document service.`)
    } catch (error) {
      setGenerationMessage(error instanceof Error ? error.message : 'Document generation failed.')
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Document Generator <Badge variant="primary" size="sm">DEMO</Badge></h1><p className="text-gray-600 dark:text-gray-400">Demo pipeline using synthetic matter data. Downloads are demo content, not legal documents, and are not linked to real matters.</p></div>
        <div className="flex gap-2"><Button variant={format === 'docx' ? 'primary' : 'outline'} size="sm" onClick={() => setFormat('docx')}><FileType2 className="mr-2 h-4 w-4" />DOCX</Button><Button variant={format === 'pdf' ? 'primary' : 'outline'} size="sm" onClick={() => setFormat('pdf')}><FileText className="mr-2 h-4 w-4" />PDF</Button></div>
      </div>

      {clausesOffline ? (
        <UnavailableNotice
          message="The clause library is temporarily unavailable."
          detail="Bundled sample clauses are shown for reference only and generation is local-only — nothing is saved to the server."
        />
      ) : error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {isLoading ? (
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">Loading generator data…</p>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><GitBranch className="h-5 w-5 text-teal-600 dark:text-teal-400" />Generation Pipeline</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
                {PIPELINE_STEPS.map((step, index) => <div key={step.name} className="relative rounded-lg border border-gray-200 p-3 dark:border-navy-700"><div className="mb-2 flex items-center justify-between"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-100 text-xs font-semibold text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">{index + 1}</span><CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" /></div><p className="text-sm font-medium text-gray-900 dark:text-gray-100">{step.name}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{step.detail}</p></div>)}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card><CardHeader><CardTitle className="flex items-center gap-2"><Database className="h-5 w-5 text-teal-600 dark:text-teal-400" />Matter and Transfer Data</CardTitle></CardHeader><CardContent><dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2"><div><dt className="text-gray-500 dark:text-gray-400">Matter</dt><dd className="font-medium text-gray-900 dark:text-gray-100">{TRANSFER_DATA.Matter?.ReferenceNumber}</dd></div><div><dt className="text-gray-500 dark:text-gray-400">Property</dt><dd className="font-medium text-gray-900 dark:text-gray-100">{TRANSFER_DATA.Property?.Address}</dd></div><div><dt className="text-gray-500 dark:text-gray-400">Seller</dt><dd className="font-medium text-gray-900 dark:text-gray-100">{TRANSFER_DATA.Seller?.FullName}</dd></div><div><dt className="text-gray-500 dark:text-gray-400">Purchaser</dt><dd className="font-medium text-gray-900 dark:text-gray-100">{TRANSFER_DATA.Purchaser?.FullName}</dd></div></dl></CardContent></Card>
            <Card><CardHeader><CardTitle className="flex items-center gap-2"><Layers className="h-5 w-5 text-teal-600 dark:text-teal-400" />Rule Engine Result</CardTitle></CardHeader><CardContent><div className="space-y-3"><div className="flex flex-wrap gap-2"><Badge variant="success" size="sm">{resolution.resolvedFields.length} data fields resolved</Badge><Badge variant="success" size="sm">{resolution.resolvedClauses.length} clauses assembled</Badge></div>{canGenerate ? <p className="flex items-center gap-2 text-sm text-green-700 dark:text-green-300"><CheckCircle2 className="h-4 w-4" />All template requirements passed. This document is ready to generate.</p> : <p className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300"><AlertCircle className="h-4 w-4" />Resolve missing fields or clauses before generating.</p>}</div></CardContent></Card>
          </div>

          <Card><CardHeader><CardTitle>Version Control Record</CardTitle></CardHeader><CardContent><dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"><div><dt className="text-gray-500 dark:text-gray-400">Template Version</dt><dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">Agreement of Sale v2.1</dd></div><div><dt className="text-gray-500 dark:text-gray-400">Clause Versions</dt><dd className="mt-1 flex flex-wrap gap-1">{resolution.resolvedClauses.map(clause => <Badge key={clause} variant="primary" size="sm">{clause}</Badge>)}</dd></div><div><dt className="text-gray-500 dark:text-gray-400">Matter ID</dt><dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">{TRANSFER_DATA.Matter?.ReferenceNumber}</dd></div><div><dt className="text-gray-500 dark:text-gray-400">Generator Version</dt><dd className="mt-1 font-medium text-gray-900 dark:text-gray-100">1.0.0</dd></div><div><dt className="text-gray-500 dark:text-gray-400">Generated Date</dt><dd className="mt-1 text-gray-600 dark:text-gray-400">Captured when the document is generated</dd></div><div><dt className="text-gray-500 dark:text-gray-400">Generation Metadata</dt><dd className="mt-1 text-gray-600 dark:text-gray-400">Embedded in the export; shown in the local history below. Not an authoritative audit record.</dd></div></dl></CardContent></Card>

          <Card><CardHeader><CardTitle>Generated Document Preview</CardTitle></CardHeader><CardContent><pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-4 font-sans text-sm leading-6 text-gray-900 dark:bg-navy-900 dark:text-gray-100">{resolution.content}</pre></CardContent></Card>

          <Card><CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-gray-900 dark:text-gray-100">Generate Agreement of Sale</p><p className="text-sm text-gray-500 dark:text-gray-400">The download is generated in the selected {format.toUpperCase()} format.</p></div><Button disabled={!canGenerate || isGenerating} onClick={generateDocument}><FileDown className="mr-2 h-4 w-4" />{isGenerating ? 'Generating...' : `Generate ${format.toUpperCase()}`}</Button></CardContent></Card>
          {generationMessage && <p className={`flex items-center gap-2 text-sm ${generationMessage.includes('failed') || generationMessage.includes('Resolve') ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}><Wand2 className="h-4 w-4" />{generationMessage}</p>}

          <Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="h-5 w-5 text-teal-600 dark:text-teal-400" />Local Generation History</CardTitle></CardHeader><CardContent><p className="mb-3 text-xs text-gray-500 dark:text-gray-400">Session-local generation metadata for this demo pipeline — not an authoritative audit record.</p>{historyError ? <UnavailableNotice message="Generated document history is temporarily unavailable." detail="Any entries below were generated in this session only and are not saved to the server." /> : null}{generationHistory.length === 0 && !historyError ? <p className="text-sm text-gray-500 dark:text-gray-400">No generated documents are recorded.</p> : <div className="space-y-3">{generationHistory.map(entry => <div key={entry.documentId} className="flex flex-col gap-2 border-b border-gray-100 pb-3 text-sm last:border-0 last:pb-0 dark:border-navy-700 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-gray-900 dark:text-gray-100">{entry.fileName}.{entry.format.toLowerCase()}</p><p className="text-gray-600 dark:text-gray-400">Matter {entry.matterId} · Template v{entry.templateVersion} · Generator v{entry.generatorVersion}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Clauses: {entry.clauseVersions.join(', ') || 'None'}</p></div><div className="text-xs text-gray-500 dark:text-gray-400">Generated by {entry.actor}<br />{new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.generatedDate))}</div></div>)}</div>}</CardContent></Card>
        </>
      )}
    </div>
  )
}

export { DocumentGenerator }
