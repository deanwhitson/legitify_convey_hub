// Mock @sumsub/websdk-react for the demo harness — aliased only by
// vite.config.idv.ts. Emits no provider traffic; exposes window.__sdkEmit /
// __sdkExpire / __sdkError so mounted-browser checks can drive the exact
// message lifecycle the real SDK produces.
import React, { useEffect, useRef } from 'react'

export interface MockWebSdkProps {
  accessToken: string
  expirationHandler: () => Promise<string>
  onMessage?: (type: string, payload?: unknown) => void
  onError?: (error: unknown) => void
}

const w = window as unknown as Record<string, unknown>

const MockSumsubWebSdk: React.FC<MockWebSdkProps> = (props) => {
  const ref = useRef(props)
  ref.current = props
  useEffect(() => {
    ;(w.__sdkMounts as unknown[] | undefined)?.push?.('mounted')
    return () => {
      ;(w.__sdkMounts as unknown[] | undefined)?.push?.('unmounted')
    }
  }, [])
  useEffect(() => {
    w.__sdkEmit = (type: string, payload?: unknown) => {
      ref.current.onMessage?.(type, payload)
    }
    w.__sdkExpire = () => ref.current.expirationHandler()
    w.__sdkError = (error: unknown) => ref.current.onError?.(error)
    return () => {
      delete w.__sdkEmit
      delete w.__sdkExpire
      delete w.__sdkError
    }
  }, [])
  return (
    <div data-testid="mock-sumsub-sdk" data-token={props.accessToken.slice(0, 12)}>
      Simulated provider capture container (mocked WebSDK — no provider traffic)
    </div>
  )
}

export default MockSumsubWebSdk
