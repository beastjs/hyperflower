import { createHiggsfieldClient, type HiggsfieldClient } from '@higgsfield/client/v2'

export const hf: HiggsfieldClient = createHiggsfieldClient({
  credentials: process.env.HF_CREDENTIALS,
  // Optional configuration
  baseURL: 'https://api.higgsfield.ai', // Default
  timeout: 120000, // 2 minutes default
  maxRetries: 3,
  retryBackoff: 1000,
  retryMaxBackoff: 60000,
  pollInterval: 2000, // Check every 2 seconds
  maxPollTime: 300000, // Timeout after 5 minutes
  headers: {
    'X-Custom-Header': 'value'
  }
})

export type ImageInputOptions = {
  prompt: string
  aspect_ratio?: string
  safety_tolerance?: number
  seed?: number
}
