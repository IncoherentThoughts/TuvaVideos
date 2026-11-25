// The TV's own screensaver. Samsung (Tizen) starts it after a few minutes without a remote key press, even over a
// playing <video>, and it stops playback: an app that plays must say so through `webapis.appcommon`. The Player
// holds it off while a Video plays and gives it back when paused, failed or left; menus never touch it, so the
// screensaver comes on there as usual. Nothing happens on LG, in a desktop browser, or with an older webapis.js.

interface AppCommon {
  setScreenSaver: (state: number, ok?: () => void, err?: (e: unknown) => void) => void
  AppCommonScreenSaverState: { SCREEN_SAVER_OFF: number; SCREEN_SAVER_ON: number }
}

const appCommon = (): AppCommon | null => {
  const w = typeof window !== "undefined" ? (window as unknown as { webapis?: { appcommon?: AppCommon } }) : null
  const ac = w?.webapis?.appcommon
  return ac && typeof ac.setScreenSaver === "function" && ac.AppCommonScreenSaverState ? ac : null
}

/** `true` holds the screensaver off (a Video is playing); `false` lets it come on again. */
export function holdScreenSaver(hold: boolean): void {
  const ac = appCommon()
  if (!ac) return
  const s = ac.AppCommonScreenSaverState
  try {
    ac.setScreenSaver(hold ? s.SCREEN_SAVER_OFF : s.SCREEN_SAVER_ON, undefined, (e) => console.warn("[tv screensaver]", e))
  } catch (e) {
    console.warn("[tv screensaver]", e)
  }
}
