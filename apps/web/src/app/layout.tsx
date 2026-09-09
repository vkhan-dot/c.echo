import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Centras.Echo — Корпоративные видеоконференции',
  description: 'Защищённая платформа видеозвонков с протоколированием встреч через Senti',
  keywords: 'видеоконференции, корпоративные звонки, протоколирование встреч, Centras',
  icons: {
    icon: '/logo.svg',
  },
  openGraph: {
    title: 'Centras.Echo',
    description: 'Корпоративные видеоконференции с протоколами Senti',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
