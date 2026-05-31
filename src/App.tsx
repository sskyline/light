import { useLightState, useMemos, useSystem } from "./hooks/useLightEvents";
import { Island } from "./components/Island";

export function App() {
  const state = useLightState();
  const memos = useMemos();
  const system = useSystem();

  return <Island sessions={state.sessions ?? []} memos={memos} system={system} />;
}
