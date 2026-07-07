import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPrice(price: number, decimals = 5): string {
  return price.toFixed(decimals)
}

export function formatPips(pips: number): string {
  const sign = pips >= 0 ? '+' : ''
  return `${sign}${pips.toFixed(1)}p`
}

export function formatUsd(amount: number): string {
  const sign = amount >= 0 ? '+' : ''
  return `${sign}$${Math.abs(amount).toFixed(2)}`
}

export function formatPct(value: number): string {
  return `${value.toFixed(1)}%`
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('pt-BR', {
    weekday: 'short', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  })
}

export function formatTimeShort(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('pt-BR', {
    weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  })
}
