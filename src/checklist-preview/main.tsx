import React from 'react'
import { createRoot } from 'react-dom/client'
import { DocumentChecklistPreviewPage } from './DocumentChecklistPreview'
import '../index.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DocumentChecklistPreviewPage />
  </React.StrictMode>,
)
