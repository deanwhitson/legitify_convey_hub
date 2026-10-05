import { Document, Packer, Paragraph, TextRun } from 'docx'
import { jsPDF } from 'jspdf'
import { LegalClause } from './clauseLibrary'
import { MatterTemplateData, resolveTemplate, TemplateResolution } from './templateEngine'

export const GENERATOR_VERSION = '1.0.0'

// Display-only attribution label used when the session carries no usable
// name. It is not an authoritative audit identity and must never be a
// fabricated person.
export const UNAVAILABLE_ACTOR_LABEL = 'User name unavailable'

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export interface GenerationEvent {
  id: string
  action: 'Generated'
  actor: string
  timestamp: string
  format: 'DOCX' | 'PDF'
}

export interface DocumentVersionMetadata {
  documentId: string
  templateVersion: string
  clauseVersions: string[]
  generatedDate: string
  matterId: string
  generatorVersion: string
  generationEvents: GenerationEvent[]
}

export interface GenerationRequest {
  template: string
  templateVersion: string
  matterData: MatterTemplateData
  clauses: LegalClause[]
  fileName: string
  format: 'DOCX' | 'PDF'
  generatedBy?: string
  // Optional visible notice rendered as the first line of the document body
  // (e.g. the demo-content label). Display text only — not a legal signature.
  notice?: string
}

export interface GeneratedDocument {
  fileName: string
  resolution: TemplateResolution
  metadata: DocumentVersionMetadata
}

const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export const resolveGeneratedDocument = ({ template, templateVersion, matterData, clauses, fileName, format, generatedBy }: GenerationRequest): GeneratedDocument => {
  const resolution = resolveTemplate(template, matterData, clauses)
  if (resolution.unresolvedFields.length || resolution.undefinedFields.length || resolution.unresolvedClauses.length) {
    throw new Error('Resolve all template fields and clauses before generating a document.')
  }

  const generatedDate = new Date().toISOString()
  const matterId = matterData.Matter?.ReferenceNumber
  if (!matterId) throw new Error('A Matter ID is required before generating a document.')

  const generationEvent: GenerationEvent = {
    id: crypto.randomUUID(),
    action: 'Generated',
    actor: text(generatedBy) || UNAVAILABLE_ACTOR_LABEL,
    timestamp: generatedDate,
    format
  }

  return {
    fileName,
    resolution,
    metadata: {
      documentId: crypto.randomUUID(),
      templateVersion,
      clauseVersions: resolution.resolvedClauses,
      generatedDate,
      matterId,
      generatorVersion: GENERATOR_VERSION,
      generationEvents: [generationEvent]
    }
  }
}

const metadataDescription = (metadata: DocumentVersionMetadata) => JSON.stringify(metadata)

export const docxProperties = (generatedDocument: GeneratedDocument) => ({
  title: generatedDocument.fileName,
  subject: `Matter ${generatedDocument.metadata.matterId} | Template ${generatedDocument.metadata.templateVersion}`,
  creator: `Legitify ConveyHub Generator v${generatedDocument.metadata.generatorVersion}`,
  lastModifiedBy: generatedDocument.metadata.generationEvents[0].actor,
  keywords: generatedDocument.metadata.clauseVersions.join(', '),
  description: metadataDescription(generatedDocument.metadata),
})

export const pdfProperties = (generatedDocument: GeneratedDocument) => ({
  title: generatedDocument.fileName,
  subject: metadataDescription(generatedDocument.metadata),
  author: `Legitify ConveyHub Generator v${generatedDocument.metadata.generatorVersion}`,
  keywords: generatedDocument.metadata.clauseVersions.join(', '),
  creator: 'Legitify ConveyHub'
})

const documentBody = (content: string, notice?: string): string => {
  const label = text(notice)
  return label ? `${label}\n\n${content}` : content
}

export const buildDocxDocument = async (request: Omit<GenerationRequest, 'format'>) => {
  const generatedDocument = resolveGeneratedDocument({ ...request, format: 'DOCX' })
  const document = new Document({
    ...docxProperties(generatedDocument),
    sections: [{
      children: documentBody(generatedDocument.resolution.content, request.notice).split('\n').map(line => new Paragraph({
        children: [new TextRun(line || ' ')]
      }))
    }]
  })
  return { generatedDocument, document }
}

export const generateDocxDocument = async (request: Omit<GenerationRequest, 'format'>): Promise<GeneratedDocument> => {
  const { generatedDocument, document } = await buildDocxDocument(request)
  const blob = await Packer.toBlob(document)
  downloadBlob(blob, `${generatedDocument.fileName}.docx`)
  return generatedDocument
}

export const buildPdfDocument = (request: Omit<GenerationRequest, 'format'>) => {
  const generatedDocument = resolveGeneratedDocument({ ...request, format: 'PDF' })
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
  const margin = 54
  const lineHeight = 18
  const pageHeight = pdf.internal.pageSize.getHeight()
  const lines = pdf.splitTextToSize(documentBody(generatedDocument.resolution.content, request.notice), pdf.internal.pageSize.getWidth() - margin * 2) as string[]
  let y = margin

  lines.forEach(line => {
    if (y > pageHeight - margin) {
      pdf.addPage()
      y = margin
    }
    pdf.text(line, margin, y)
    y += lineHeight
  })

  pdf.setProperties(pdfProperties(generatedDocument))
  return { generatedDocument, pdf }
}

export const generatePdfDocument = (request: Omit<GenerationRequest, 'format'>): GeneratedDocument => {
  const { generatedDocument, pdf } = buildPdfDocument(request)
  pdf.save(`${generatedDocument.fileName}.pdf`)
  return generatedDocument
}
