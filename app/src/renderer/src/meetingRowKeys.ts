type RowKey = Pick<KeyboardEvent, 'key' | 'repeat' | 'defaultPrevented' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'preventDefault'>

export function deleteMeetingFromKey(event: RowKey, rowFocused: boolean, recording: boolean, trash: () => void) {
  if (!rowFocused || recording || event.key !== 'Delete' || event.repeat || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  event.preventDefault()
  trash()
}
