// Hooks run with piped stdin. Identify the originating pane from its own ID.
export function terminalSource(env = process.env) {
  if (env.TMUX || env.STY || env.SSH_CONNECTION) return null;
  if (env.REX_SESSION && env.REX_BLOCK) {
    return { kind: "rex", session: env.REX_SESSION, id: env.REX_BLOCK };
  }
  if (env.TERM_PROGRAM === "iTerm.app" && env.ITERM_SESSION_ID) {
    return { kind: "iterm", id: env.ITERM_SESSION_ID };
  }
  if (env.TERM_PROGRAM === "ghostty" && env.GHOSTTY_SURFACE_ID) {
    return { kind: "ghostty", id: env.GHOSTTY_SURFACE_ID };
  }
  return null;
}
