import { describe, expect, it } from 'vitest'
import { readCall, summarize, zoomTile, type AxNode, type AxWindow } from '../src/main/callNames/parse'

const node = (r: string, o: Partial<AxNode> = {}, ...k: AxNode[]): AxNode => ({ r, ...o, ...(k.length ? { k } : {}) })
const win = (tree: AxNode, title?: string): AxWindow => ({ title, tree })

// ---- Zoom: shapes from Zoom 7.1's meeting window, as other projects measured it, with made-up names ----
const zoomTileNode = (d: string) => node('AXTabGroup', { d, w: 320, h: 180 })
const zoomRow = (text: string) => node('AXRow', {}, node('AXCell', {}, node('AXStaticText', { v: text }), node('AXImage', { d: 'Computer audio unmuted' })))
const zoomWindow = (tiles: string[], rows: string[] = [], extra: AxNode[] = []) => win(node('AXWindow', { i: 'zm.meeting.window.main' },
  node('AXGroup', {}, ...tiles.map(zoomTileNode)),
  ...(rows.length ? [node('AXScrollArea', {}, node('AXOutline', { d: 'Participants list' }, ...rows.map(zoomRow)))] : []),
  node('AXButton', { d: 'Mute my audio', i: 'audio' }), ...extra))

describe('Zoom', () => {
  it('reads a tile: the name, and whether it carries the active-speaker mark', () => {
    expect(zoomTile('Ana Ruiz, Computer audio unmuted, Video off, Active speaker')).toEqual({ name: 'Ana Ruiz', talking: true })
    expect(zoomTile('Ana Ruiz, Computer audio muted, Video on')).toEqual({ name: 'Ana Ruiz', talking: false })
    // a comma in a name stays; a role tag goes
    expect(zoomTile('Smith, Dana (Host), Computer audio unmuted')).toEqual({ name: 'Smith, Dana', talking: false })
    // another language Zoom speaks
    expect(zoomTile('Ana Ruiz, Audio de la computadora no silenciado, Orador activo')).toEqual({ name: 'Ana Ruiz', talking: true })
    // not a tile: buttons and anything without Zoom's status words
    expect(zoomTile('Mute my audio')).toBeNull()
    expect(zoomTile('Share screen, Alt+S')).toBeNull()
  })

  it('a call of three: the marked tile talks; "(me)" in the list is the person using Yogurt', () => {
    const r = readCall('zoom', [zoomWindow(
      ['Alex Morgan, Computer audio unmuted, Video on', 'Dana Smith, Computer audio unmuted, Video off, Active speaker', 'Ann Lee, Computer audio muted, Video off'],
      ['Alex Morgan (me)', 'Dana Smith (Host)', 'Ann Lee'],
    )])
    expect(r).toEqual({ speaking: ['Dana Smith'], participants: ['Alex Morgan', 'Dana Smith', 'Ann Lee'], me: 'Alex Morgan' })
  })

  it('with the list closed nobody is known to be "me"; with nobody marked nobody talks', () => {
    const r = readCall('zoom', [zoomWindow(['Alex Morgan, Computer audio unmuted', 'Dana Smith, Computer audio unmuted'])])
    expect(r).toEqual({ speaking: [], participants: ['Alex Morgan', 'Dana Smith'], me: null })
  })

  it('the small floating window says who is talking', () => {
    const r = readCall('zoom', [win(node('AXWindow', {}, node('AXStaticText', { v: 'Talking: Dana Smith' })))])
    expect(r.speaking).toEqual(['Dana Smith'])
  })

  it('a Zoom that changed its window reads as nothing, never a wrong name', () => {
    const r = readCall('zoom', [win(node('AXWindow', {}, node('AXGroup', { d: 'Dana Smith' }), node('AXTabGroup', { d: 'Chat' }), node('AXStaticText', { v: 'Dana Smith' })))])
    expect(r).toEqual({ speaking: [], participants: [], me: null })
  })
})

// ---- Google Meet in a browser: names as text in each tile, the talking tile marked by a class ----
/** a tile: the name text seven levels down, the class marks on the tile's own elements */
const meetTile = (name: string, classes: string[] = []) => {
  let n = node('AXStaticText', { v: name })
  for (let i = 0; i < 6; i++) n = node('AXGroup', i === 3 ? { c: ['notranslate'] } : {}, n)
  return node('AXGroup', { c: ['oZRSLe', ...classes] }, node('AXGroup', { d: 'More options for ' + name }), n)
}
const meetWindow = (tiles: AxNode[], title = 'Meet - abc-defg-hij') => win(node('AXWindow', { t: title },
  node('AXGroup', {}, node('AXWebArea', { t: title }, node('AXGroup', {}, node('AXGroup', {}, ...tiles)),
    // the meeting code and the clock are text too, never people
    node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXGroup', {}, node('AXStaticText', { v: 'abc-defg-hij' }), node('AXStaticText', { v: '10:42' }))))))))))), title)

describe('Google Meet', () => {
  it('reads each tile once, and the tile with the talking class', () => {
    const r = readCall('meet', [meetWindow([meetTile('You'), meetTile('Dana Smith', ['v5h6Xc']), meetTile('Ann Lee')])])
    expect(r).toEqual({ speaking: ['Dana Smith'], participants: ['You', 'Dana Smith', 'Ann Lee'], me: 'You' })
  })

  it('a renamed class marks nobody; a tile shown "(Presenting)" is still the person', () => {
    const r = readCall('meet', [meetWindow([meetTile('You', ['zz9']), meetTile('Dana Smith (Presenting)', ['Abc12'])])])
    expect(r).toEqual({ speaking: [], participants: ['You', 'Dana Smith'], me: 'You' })
    // a class found later can be given
    expect(readCall('meet', [meetWindow([meetTile('Dana Smith', ['Abc12'])])], { talkingClasses: ['Abc12'] }).speaking).toEqual(['Dana Smith'])
  })

  it('only windows showing a Meet call are read', () => {
    expect(readCall('meet', [meetWindow([meetTile('Dana Smith', ['v5h6Xc'])], 'Inbox - Gmail')]).participants).toEqual([])
  })
})

// ---- Teams: words only (no measured tree yet) ----
describe('Microsoft Teams', () => {
  it('reads "Name, speaking", tiles with a mic or video state, and "(You)"', () => {
    const tree = node('AXWindow', {},
      node('AXGroup', { d: 'Dana Smith, unmuted, video on' }, node('AXStaticText', { v: 'Dana Smith' })),
      node('AXGroup', { d: 'Dana Smith, speaking' }),
      node('AXGroup', { d: 'Ann Lee, muted' }),
      node('AXRow', { d: 'Alex Morgan (You)' }),
      node('AXButton', { d: 'Leave' }))
    expect(readCall('teams', [win(tree, 'Weekly sync | Microsoft Teams')])).toEqual({ speaking: ['Dana Smith'], participants: ['Dana Smith', 'Ann Lee', 'Alex Morgan'], me: 'Alex Morgan' })
  })

  it('never takes "You" or the app\'s own words for a person', () => {
    const tree = node('AXWindow', {}, node('AXStaticText', { v: 'You are speaking' }), node('AXButton', { d: 'Mic on' }))
    expect(readCall('teams', [win(tree)])).toEqual({ speaking: [], participants: [], me: null })
  })
})

describe('summarize: a short picture of the tree for the log', () => {
  it('counts roles and shows the first texts, with ids and classes', () => {
    const s = summarize([zoomWindow(['Dana Smith, Computer audio unmuted, Active speaker'])], 4)
    expect(s.split('\n')[0]).toMatch(/^roles: AXWindow=1 .*AXTabGroup=1/)
    expect(s).toContain('AXTabGroup "Dana Smith, Computer audio unmuted, Active speaker"')
    expect(s.split('\n')).toHaveLength(5)
  })
})
