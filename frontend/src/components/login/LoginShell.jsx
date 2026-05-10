'use client'

import { Box, ThemeProvider, createTheme, useTheme } from '@mui/material'
import LoginBackground from '@components/LoginBackground'
import LoginFormPanel from './LoginFormPanel'

export default function LoginShell({ branding, brandingLoading, ...formProps }) {
  const parentTheme = useTheme()

  const darkLoginTheme = createTheme({
    ...parentTheme,
    palette: {
      ...parentTheme.palette,
      mode: 'dark',
      background: { ...parentTheme.palette.background, default: '#080c18', paper: '#0c1224' },
      text: { primary: '#e7eaf3', secondary: 'rgba(231, 234, 243, 0.7)' },
    },
  })

  return (
    <ThemeProvider theme={darkLoginTheme}>
      <Box
        sx={{
          position: 'relative',
          minHeight: '100vh',
          width: '100%',
          color: '#e7eaf3',
          backgroundColor: '#080c18',
          overflow: 'hidden',
          '--mui-palette-text-primary': '#e7eaf3',
          '--mui-palette-text-secondary': 'rgba(231, 234, 243, 0.7)',
          '--mui-palette-text-disabled': 'rgba(231, 234, 243, 0.4)',
        }}
      >
        <LoginBackground inPanel overlayOpacity={0.55} />

        <Box
          sx={{
            position: 'relative',
            zIndex: 2,
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            opacity: brandingLoading ? 0 : 1,
            transition: 'opacity 0.2s ease-in',
            px: 3,
            pt: { xs: '8vh', md: '10vh' },
            pb: 6,
          }}
        >
          <LoginFormPanel branding={branding} {...formProps} />
        </Box>
      </Box>
    </ThemeProvider>
  )
}
