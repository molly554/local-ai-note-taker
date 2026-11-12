const footer = document.querySelector('.site-footer')
const field = footer.querySelector('.footer-field'), dock = footer.querySelector('.footer-dock')

new ResizeObserver(() => {
  const { width: w, height: h } = footer.getBoundingClientRect(), style = getComputedStyle(footer)
  const x = parseFloat(style.getPropertyValue('--notch-x')), y = parseFloat(style.getPropertyValue('--notch-y'))
  const top = parseFloat(style.getPropertyValue('--field-top')) || 0
  const r = parseFloat(style.getPropertyValue('--corner')), size = parseFloat(style.getPropertyValue('--icon-size')), outer = 22
  field.setAttribute('viewBox', `0 0 ${w} ${h}`)
  const path = `M ${x+r} ${top} H ${w-outer} Q ${w} ${top} ${w} ${top+outer} V ${h-outer} Q ${w} ${h} ${w-outer} ${h} H ${outer} Q 0 ${h} 0 ${h-outer} V ${y+r} Q 0 ${y} ${r} ${y} H ${x-r} Q ${x} ${y} ${x} ${y-r} V ${top+r} Q ${x} ${top} ${x+r} ${top} Z`
  field.querySelectorAll('path').forEach(node => node.setAttribute('d', path))
  const dockWidth = dock.getBoundingClientRect().width
  // One gentle ramp spans the whole footer; the icon samples the same heights across the gap.
  const base = field.querySelector('#footer-base')
  base.setAttribute('x2', 0); base.setAttribute('y2', h)
  // Hold the matching icon palette through both notch joints before the diagonal wash.
  const wash = field.querySelector('#footer-wash')
  wash.setAttribute('x2', (w+h)/2); wash.setAttribute('y2', (w+h)/2)
  wash.querySelector('.wash-start').setAttribute('offset', (x+y+r)/(w+h))
  const art = dock.querySelector('svg'), width = 236 * dockWidth / size
  art.querySelector('#footer-icon-face').setAttribute('y2', 10 + 236 * h / size)
  art.setAttribute('viewBox', `10 10 ${width} 236`)
  art.querySelectorAll('rect').forEach(rect => rect.setAttribute('width', width-2*(Number(rect.getAttribute('x'))-10)))
  footer.dataset.shaped = 'true'
}).observe(footer)
