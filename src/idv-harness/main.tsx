import React from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { installMockIdvBackend } from './mockBackend'
import { HarnessApp } from './HarnessApp'

installMockIdvBackend()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HarnessApp />
  </React.StrictMode>,
)
