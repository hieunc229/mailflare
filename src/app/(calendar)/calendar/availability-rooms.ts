import { createContext } from "react";

/** The rooms chosen for the event being edited. The editor provides them; the availability panel reads them, so the panel's own props stay the guests and the times. */
export const AvailabilityRoomsContext = createContext<{ id: string; name: string }[]>([]);
