import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import './index.css'
import App from './App.jsx'
import { theme, cssVariablesResolver } from './theme.js'
import { installSnapshotBridge } from './utils/characterSnapshots.js'

installSnapshotBridge()


createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </StrictMode>,
)
