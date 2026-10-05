import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { Header, sessionDisplayName, sessionSubtitle } from './Header'
import { clearSession, setSession } from '../lib/api/session'

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)

function render() {
  return renderToStaticMarkup(<MemoryRouter><Header /></MemoryRouter>)
}

function signIn(user: Record<string, unknown> | null, sid: string, principalKey: string) {
  setSession({ accessToken: `token-${sid}`, expires: 9999999999, user, sid, principalKey })
}

afterEach(() => clearSession())

describe('Header session identity', () => {
  it('renders the verified session user name and never a placeholder', () => {
    signIn({ name: 'Jane Naidoo' }, 'sid-1', PK_A)
    const html = render()
    assert.match(html, /Jane Naidoo/)
    assert.doesNotMatch(html, /John Doe|Senior Partner/)
  })

  it('derives the name from first_name/surname and first_name/last_name pairs', () => {
    assert.equal(sessionDisplayName({ first_name: 'Jane', surname: 'Naidoo' }), 'Jane Naidoo')
    assert.equal(sessionDisplayName({ first_name: 'Jane', last_name: 'Naidoo' }), 'Jane Naidoo')
    assert.equal(sessionDisplayName({ firstName: 'Jane', lastName: 'Naidoo' }), 'Jane Naidoo')
    assert.equal(sessionDisplayName({ first_name: 'Jane' }), 'Jane')
    assert.equal(sessionDisplayName({ surname: 'Naidoo' }), 'Naidoo')
  })

  it('prefers a direct name/display_name field and trims whitespace', () => {
    assert.equal(sessionDisplayName({ name: '  Jane Naidoo  ' }), 'Jane Naidoo')
    assert.equal(sessionDisplayName({ display_name: 'J. Naidoo' }), 'J. Naidoo')
    assert.equal(sessionDisplayName({ name: '   ', first_name: 'Jane' }), 'Jane')
  })

  it('falls back to a session email, then a neutral label', () => {
    assert.equal(sessionDisplayName({ email: 'jane@example.test' }), 'jane@example.test')
    assert.equal(sessionDisplayName({}), 'Signed-in user')
    assert.equal(sessionDisplayName({ name: 42, first_name: null }), 'Signed-in user')
    assert.equal(sessionDisplayName(null), 'Signed-in user')
    assert.equal(sessionDisplayName(undefined), 'Signed-in user')
  })

  it('handles malformed identity fields without leaking coerced garbage', () => {
    for (const bad of [42, true, {}, { first: 'Jane' }, ['Jane', 'Naidoo'], ['x'], Symbol('x'), 0]) {
      assert.equal(sessionDisplayName({ name: bad, display_name: bad, full_name: bad, first_name: bad, surname: bad, email: bad }), 'Signed-in user')
      assert.equal(sessionSubtitle({ role_name: bad, accountable_institution_name: bad }), '')
    }
    const html = render()
    assert.doesNotMatch(html, /\[object Object\]|John Doe|Senior Partner/)
    signIn({ name: ['Jane', 'Naidoo'], role_name: { title: 'Conveyancer' }, email: 0 }, 'sid-1', PK_A)
    const mounted = render()
    assert.match(mounted, /Signed-in user/)
    assert.doesNotMatch(mounted, /\[object Object\]|Jane|Conveyancer/)
  })

  it('shows the neutral label without a session and on logout', () => {
    let html = render()
    assert.match(html, /Signed-in user/)
    assert.doesNotMatch(html, /John Doe|Senior Partner/)
    signIn({ name: 'Jane Naidoo' }, 'sid-1', PK_A)
    html = render()
    assert.match(html, /Jane Naidoo/)
    clearSession()
    html = render()
    assert.match(html, /Signed-in user/)
    assert.doesNotMatch(html, /Jane Naidoo|John Doe/)
  })

  it('renders the new principal on account change, never the previous identity', () => {
    signIn({ name: 'Jane Naidoo', role_name: 'Conveyancer' }, 'sid-1', PK_A)
    assert.match(render(), /Jane Naidoo/)
    signIn({ first_name: 'Pieter', surname: 'Botha' }, 'sid-2', PK_B)
    const html = render()
    assert.match(html, /Pieter Botha/)
    assert.doesNotMatch(html, /Jane Naidoo|Conveyancer/)
  })

  it('renders role and institution subtitles only from session data', () => {
    signIn({ name: 'Jane Naidoo', role_name: 'Conveyancer', accountable_institution_name: 'Example Attorneys' }, 'sid-1', PK_A)
    assert.match(render(), /Conveyancer · Example Attorneys/)
    signIn({ name: 'Pieter Botha' }, 'sid-2', PK_B)
    const html = render()
    assert.doesNotMatch(html, /Senior Partner|Conveyancer|Example Attorneys/)
  })

  it('shows the neutral fallback when a same-principal session has no user', () => {
    // doRefresh preserves session.user only for the same principalKey;
    // the header simply renders whatever the session currently holds.
    signIn({ name: 'Jane Naidoo' }, 'sid-1', PK_A)
    assert.match(render(), /Jane Naidoo/)
    setSession({ accessToken: 'refreshed', expires: 9999999999, user: null, sid: 'sid-1', principalKey: PK_A })
    assert.match(render(), /Signed-in user/)
  })

  it('sessionSubtitle joins only session fields and tolerates missing ones', () => {
    assert.equal(sessionSubtitle({ role_name: 'Conveyancer', accountable_institution_name: 'Example Attorneys' }), 'Conveyancer · Example Attorneys')
    assert.equal(sessionSubtitle({ roleName: 'Conveyancer' }), 'Conveyancer')
    assert.equal(sessionSubtitle({ institution_name: 'Example Attorneys' }), 'Example Attorneys')
    assert.equal(sessionSubtitle({}), '')
    assert.equal(sessionSubtitle(null), '')
  })
})
