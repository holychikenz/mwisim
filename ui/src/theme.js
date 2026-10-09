// Moss & Stone — the sim's Japanese-garden theme.
//
// Components ask Mantine for colours by name (color="red", c="dimmed", …), so
// the whole palette lives here: redefining a named scale recolours every use
// of it. Semantic names keep their meaning (red = bad, yellow/orange = warn,
// teal/green = good); they are only re-tuned to sit on moss and stone.
import { createTheme } from '@mantine/core'

// One face everywhere: the platform UI font, which is built for dense small
// text. Weight, not a second family, sets the heading hierarchy.
const BODY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const HEAD = BODY
const MONO = "ui-monospace, Menlo, monospace"

// Accent: moss. Shade 5 is the dark-scheme primary, 7 the light-scheme one.
const moss = ['#f2f6ec', '#e3ecd6', '#c8dbae', '#abc886', '#93b96c', '#86ab5f', '#6b9148', '#4b7631', '#3b5e26', '#2b451b']
// Secondary: raked sand, for data marks (bars, sparklines).
const sand = ['#f8f4ea', '#efe6d0', '#e2d3ae', '#d4c094', '#c8b78a', '#b39c68', '#9a8250', '#7d683e', '#5f4f2f', '#433721']
// Dark scheme ground: stone with a moss bias. 0 = text … 7 = body … 9 = deepest.
const dark = ['#e2e6da', '#c3c9ba', '#8d9785', '#6d7766', '#3a4637', '#2e382c', '#242c22', '#1a2019', '#151a14', '#101310']
// Light scheme neutrals: warm granite. 0 = faintest fill … 9 = ink.
const gray = ['#f7f6f0', '#efede4', '#e5e3d6', '#d3d0c0', '#bdb9a7', '#9a9886', '#666e5f', '#4f5649', '#353b31', '#20261d']
// Semantic scales, tuned toward the garden.
const red = ['#fbefec', '#f4d8d1', '#e8b0a3', '#dc8873', '#d0644a', '#c45538', '#b0412a', '#8f3422', '#6e281a', '#4e1c12'] // maple rust
const yellow = ['#fbf5e6', '#f4e6c2', '#ead08a', '#e0bb5a', '#d6a440', '#c4922c', '#a8720e', '#87590b', '#664308', '#462e05'] // ochre
const orange = ['#fcf1e8', '#f6dcc6', '#ecbb92', '#e19a62', '#d6803c', '#c76e2a', '#a8581c', '#874616', '#663410', '#46240b'] // persimmon
const teal = ['#ecf6f2', '#d3eae1', '#a8d4c3', '#7cbea5', '#5ba98b', '#4a977a', '#3a7d63', '#2e634f', '#22493a', '#162f26'] // pond jade
const grape = ['#f4f0f7', '#e3d9ea', '#c8b4d6', '#ac8ec1', '#9573b0', '#8463a1', '#6c4f86', '#563e6b', '#402e50', '#2b1f36'] // wisteria
const blue = ['#edf2f6', '#d4e0ea', '#aac2d6', '#80a4c1', '#6290b2', '#4f7ea2', '#3e6886', '#30526b', '#233c4f', '#172734'] // aizome

export const theme = createTheme({
  primaryColor: 'moss',
  primaryShade: { light: 7, dark: 5 },
  autoContrast: true,
  luminanceThreshold: 0.4,
  colors: { moss, sand, dark, gray, red, yellow, orange, teal, grape, blue, indigo: moss, green: moss },
  defaultRadius: 'md',
  fontFamily: BODY,
  fontFamilyMonospace: MONO,
  headings: { fontFamily: HEAD, fontWeight: '650' },
})

// Ground and ink per scheme. Light mode's body is warm sand-white, not #fff.
export const cssVariablesResolver = () => ({
  variables: { '--app-font-head': HEAD },
  light: {
    '--mantine-color-body': '#f4f2ea',
    '--mantine-color-text': '#20261d',
    '--mantine-color-dimmed': '#666e5f',
    '--mantine-color-default': '#faf9f3',
    '--mantine-color-default-border': '#d3d0c0',
    '--app-surface': '#faf9f3',
  },
  dark: {
    '--mantine-color-body': '#131712',
    '--mantine-color-text': '#e2e6da',
    '--mantine-color-dimmed': '#8d9785',
    '--app-surface': '#1a2019',
  },
})
