import { useEffect, useRef, useState } from "react";

export function useMessageContentScroll(messageId: string, loading: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // Reset the scroll position first so the read below sees the new message at the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [messageId]);

  useEffect(() => {
    setScrolled((scrollRef.current?.scrollTop ?? 0) > 0);
  }, [messageId, loading]);

  function handleScroll() {
    setScrolled((scrollRef.current?.scrollTop ?? 0) > 0);
  }

  return { scrollRef, scrolled, handleScroll };
}
