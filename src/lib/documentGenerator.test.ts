import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Packer } from 'docx'
import JSZip from 'jszip'
import {
  UNAVAILABLE_ACTOR_LABEL,
  buildDocxDocument,
  buildPdfDocument,
  docxProperties,
  pdfProperties,
  resolveGeneratedDocument,
} from './documentGenerator'

const DEMO_NOTICE = 'DEMO — synthetic data, not for transaction use'
const TEMPLATE = 'Matter {{Matter.ReferenceNumber}} — {{Purchaser.FullName}}'
const MATTER_DATA = {
  Purchaser: { FullName: 'Demo Purchaser' },
  Matter: { ReferenceNumber: 'TRF-001' },
}

const request = (overrides: { generatedBy?: unknown; format?: 'DOCX' | 'PDF'; notice?: string } = {}) => ({
  template: TEMPLATE,
  templateVersion: '2.1',
  matterData: MATTER_DATA,
  clauses: [],
  fileName: 'DEMO-TRF-001-agreement-of-sale',
  notice: DEMO_NOTICE,
  ...overrides,
  format: (overrides.format ?? 'DOCX') as 'DOCX' | 'PDF',
  generatedBy: overrides.generatedBy as string | undefined,
})

describe('document generation provenance', () => {
  it('records the supplied session display name, trimmed', () => {
    const doc = resolveGeneratedDocument(request({ generatedBy: '  Jane Naidoo  ' }))
    assert.equal(doc.metadata.generationEvents[0].actor, 'Jane Naidoo')
    assert.equal(doc.metadata.generationEvents[0].action, 'Generated')
  })

  it('labels the actor "User name unavailable" when identity is absent or malformed', () => {
    for (const bad of [undefined, '', '   ', null, 42, true, {}, ['Jane'], Symbol('x')]) {
      const doc = resolveGeneratedDocument(request({ generatedBy: bad }))
      assert.equal(doc.metadata.generationEvents[0].actor, UNAVAILABLE_ACTOR_LABEL)
    }
    assert.equal(UNAVAILABLE_ACTOR_LABEL, 'User name unavailable')
  })

  it('writes only display attribution into DOCX core properties — never a fabricated person', () => {
    const named = docxProperties(resolveGeneratedDocument(request({ generatedBy: 'Jane Naidoo' })))
    assert.equal(named.lastModifiedBy, 'Jane Naidoo')
    const unattributed = docxProperties(resolveGeneratedDocument(request({ generatedBy: undefined })))
    assert.equal(unattributed.lastModifiedBy, 'User name unavailable')
    const description = JSON.parse(unattributed.description)
    assert.equal(description.generationEvents[0].actor, 'User name unavailable')
    assert.match(unattributed.creator, /^Legitify ConveyHub Generator v/)
    assert.equal(JSON.stringify(named).includes('John Doe'), false)
    assert.equal(JSON.stringify(unattributed).includes('John Doe'), false)
  })

  it('writes only display attribution into PDF properties — never a fabricated person', () => {
    const named = pdfProperties(resolveGeneratedDocument(request({ generatedBy: 'Pieter Botha', format: 'PDF' })))
    const subject = JSON.parse(named.subject)
    assert.equal(subject.generationEvents[0].actor, 'Pieter Botha')
    const unattributed = pdfProperties(resolveGeneratedDocument(request({ format: 'PDF' })))
    assert.equal(JSON.parse(unattributed.subject).generationEvents[0].actor, 'User name unavailable')
    assert.match(unattributed.author, /^Legitify ConveyHub Generator v/)
    assert.equal(unattributed.creator, 'Legitify ConveyHub')
    assert.equal(JSON.stringify(named).includes('John Doe'), false)
    assert.equal(JSON.stringify(unattributed).includes('John Doe'), false)
  })

  it('marks files as demo content via the supplied file name and honest metadata', () => {
    const doc = resolveGeneratedDocument(request({ generatedBy: 'Jane Naidoo' }))
    assert.match(doc.fileName, /^DEMO-/)
    assert.equal(docxProperties(doc).title, doc.fileName)
    assert.equal(pdfProperties(doc).title, doc.fileName)
    assert.equal(doc.metadata.matterId, 'TRF-001')
    assert.equal(doc.metadata.generatorVersion.length > 0, true)
    assert.equal(doc.metadata.documentId.length > 0, true)
  })

  it('still refuses generation with unresolved template requirements', () => {
    assert.throws(() => resolveGeneratedDocument({
      ...request({ generatedBy: 'Jane Naidoo' }),
      template: 'Matter {{Matter.ReferenceNumber}} — {{Missing.Field}}',
    }))
  })
})

describe('generated file contents (real artifacts)', () => {
  it('DOCX body visibly states the demo notice and core.xml carries the session actor', async () => {
    const { document } = await buildDocxDocument(request({ generatedBy: 'Jane Naidoo' }))
    const blob = await Packer.toBlob(document)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const body = await zip.file('word/document.xml')!.async('string')
    const core = await zip.file('docProps/core.xml')!.async('string')
    assert.ok(body.includes(DEMO_NOTICE), 'DOCX body must visibly carry the demo notice')
    assert.ok(body.includes('Matter TRF-001 — Demo Purchaser'), 'DOCX body must carry resolved template content')
    assert.ok(core.includes('<cp:lastModifiedBy>Jane Naidoo</cp:lastModifiedBy>'))
    assert.ok(core.includes('DEMO-TRF-001-agreement-of-sale'), 'DOCX title carries the demo filename')
    assert.equal(body.includes('John Doe'), false)
    assert.equal(core.includes('John Doe'), false)
  })

  it('DOCX shows "User name unavailable" in file metadata when no identity exists', async () => {
    const { document } = await buildDocxDocument(request({ generatedBy: {} }))
    const zip = await JSZip.loadAsync(await (await Packer.toBlob(document)).arrayBuffer())
    const body = await zip.file('word/document.xml')!.async('string')
    const core = await zip.file('docProps/core.xml')!.async('string')
    assert.ok(core.includes('<cp:lastModifiedBy>User name unavailable</cp:lastModifiedBy>'))
    assert.ok(core.includes('&quot;actor&quot;:&quot;User name unavailable&quot;') || core.includes('"actor":"User name unavailable"'))
    assert.ok(body.includes(DEMO_NOTICE))
    assert.equal(body.includes('[object Object]'), false)
    assert.equal(core.includes('[object Object]'), false)
  })

  it('PDF page content visibly states the demo notice and the info dict carries the actor', () => {
    const { pdf } = buildPdfDocument(request({ generatedBy: 'Pieter Botha', format: 'PDF' }))
    const bytes = Buffer.from(pdf.output('arraybuffer')).toString('latin1')
    // Em dash is encoded non-ASCII in WinAnsi; assert on the ASCII fragments.
    const demo = bytes.indexOf('DEMO')
    const notice = bytes.indexOf('synthetic data, not for transaction use')
    assert.ok(demo !== -1 && notice !== -1 && demo < notice, 'PDF body must visibly carry the demo notice')
    assert.ok(bytes.includes('"actor":"Pieter Botha"'), 'PDF subject metadata carries the session actor')
    assert.ok(bytes.includes('DEMO-TRF-001-agreement-of-sale'), 'PDF title carries the demo filename')
    assert.ok(bytes.includes('Matter TRF-001'), 'PDF body carries resolved template content')
    assert.equal(bytes.includes('John Doe'), false)
  })

  it('PDF labels an absent identity as unavailable rather than fabricating one', () => {
    const { pdf } = buildPdfDocument(request({ generatedBy: ['Jane'], format: 'PDF' }))
    const bytes = Buffer.from(pdf.output('arraybuffer')).toString('latin1')
    assert.ok(bytes.includes('"actor":"User name unavailable"'))
    assert.ok(bytes.includes('synthetic data, not for transaction use'))
    assert.equal(bytes.includes('[object Object]'), false)
    assert.equal(bytes.includes('Jane'), false)
  })
})
