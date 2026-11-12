#!/bin/sh
# Starts Yogurt (yogurt-bin) on X11 through XWayland on a Wayland desktop, where the recorder widget and the
# "Take notes" card can float (src/main/display.ts). The switch has to be there before Electron starts, and an
# in-app relaunch can't mount the AppImage again, so it's added here. A switch given by hand wins.
here=$(dirname "$(readlink -f "$0")")
case " $* " in *" --ozone-platform"*) ;; *)
  [ -n "$WAYLAND_DISPLAY" ] && [ -n "$DISPLAY" ] && set -- --ozone-platform=x11 "$@" ;;
esac
exec "$here/yogurt-bin" "$@"
