import { Children, createElement, createRef, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { loadingDecoration } from '../src/renderer/src/components/LoadingContent'

it('does not share live input refs or label targets with a fading placeholder', () => {
  const ref = createRef<HTMLInputElement>()
  const input = createElement('input', { ref, id: 'name', 'data-testid': 'name-input', defaultValue: 'Alex' })
  const original = createElement('label', { htmlFor: 'name' }, input)
  const copy = Children.toArray(loadingDecoration(original))[0] as ReactElement<{ children: ReactNode }>
  const field = Children.toArray(copy.props.children)[0] as ReactElement<{ ref?: unknown }>
  expect(field.props.ref).toBeNull()
  expect(renderToStaticMarkup(copy)).not.toContain('id=')
  expect(renderToStaticMarkup(copy)).toContain('value="Alex"')
  expect(input.props.ref).toBe(ref)
  expect(input.props.id).toBe('name')
})

it('preserves component data props while removing only decorative DOM identity', () => {
  const Row = ({ id }: { id: string }) => createElement('span', null, id)
  expect(renderToStaticMarkup(createElement('div', null, loadingDecoration(createElement(Row, { id: 'meeting-1' }))))).toContain('meeting-1')
})
