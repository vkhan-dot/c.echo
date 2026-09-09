import React from 'react'

export function LogoIcon({ width = 32, height = 32 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Centras.Echo">
      <defs>
        {/* Насыщенный корпоративный градиент Centras */}
        <linearGradient id="logoIconGrad" x1="6" y1="11" x2="32" y2="25">
          <stop offset="0%" stopColor="#FF1E27" /> {/* Насыщенный красный */}
          <stop offset="45%" stopColor="#A8006F" /> {/* Глубокий пурпурный */}
          <stop offset="100%" stopColor="#0047E0" /> {/* Яркий синий */}
        </linearGradient>

        {/* Мягкое премиальное свечение */}
        <filter id="logoPremiumGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#A8006F" floodOpacity="0.3" />
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#0047E0" floodOpacity="0.15" />
        </filter>
      </defs>

      {/* Группа иконки со свечением (без внешней рамки и подложки) */}
      <g filter="url(#logoPremiumGlow)">
        {/* Корпус камеры */}
        <rect x="5" y="11" width="13" height="14" rx="3.5" fill="url(#logoIconGrad)" />
        
        {/* Объектив-рупор */}
        <path d="M19 15L24.5 11.5V24.5L19 21V15Z" fill="url(#logoIconGrad)" />

        {/* Блик света на объективе */}
        <path d="M20 16.5L23 14.5V21.5L20 19.5V16.5Z" fill="#FFFFFF" opacity="0.15" />

        {/* Индикатор записи / Белая линза в камере */}
        <circle cx="8.5" cy="18" r="1.5" fill="#FFFFFF" opacity="0.9" />

        {/* Звуковые волны голосового интеллекта */}
        <path 
          d="M28 14.5C29.2 16 29.2 20 28 21.5" 
          stroke="url(#logoIconGrad)" 
          strokeWidth="2" 
          strokeLinecap="round" 
        />
        <path 
          d="M31 12.5C32.8 14.5 32.8 21.5 31 23.5" 
          stroke="url(#logoIconGrad)" 
          strokeWidth="1.5" 
          strokeLinecap="round" 
          opacity="0.55" 
        />
      </g>
    </svg>
  )
}

export function Logo({ size = 32, centered = false }: { size?: number; centered?: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      justifyContent: centered ? 'center' : 'flex-start',
      width: centered ? '100%' : 'auto'
    }}>
      <LogoIcon width={size} height={size} />
      
      <span style={{
        fontFamily: "'Outfit', 'Inter', sans-serif",
        fontSize: `${size * 0.72}px`,
        letterSpacing: '0.010em',
        display: 'flex',
        alignItems: 'center',
        userSelect: 'none',
        lineHeight: 1
      }}>
        {/* Название бренда "centras" */}
        <span style={{
          fontWeight: 900,
          background: 'linear-gradient(135deg, #FF1E27 0%, #A8006F 50%, #0047E0 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          paddingBottom: '2px'
        }}>
          centras
        </span>
        
        {/* Разделитель */}
        <span style={{
          fontWeight: 600,
          color: '#A8006F',
          opacity: 0.85,
          margin: '0 5px',
          paddingBottom: '2px'
        }}>
          ·
        </span>
        
        {/* Дополнение "echo" */}
        <span style={{
          fontWeight: 500,
          color: 'var(--logo-echo-color, #0047E0)',
          paddingBottom: '2px'
        }}>
          echo
        </span>
      </span>
    </div>
  )
}
