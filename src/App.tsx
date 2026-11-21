import { useLightState, usePresence } from "./hooks/useLightEvents";
import { Island } from "./components/Island";

export function App() {
  const state = useLightState();
  const presence = usePresence();

  return (
    <Island sessions={state.sessions ?? []} presence={presence} />
  );
}
