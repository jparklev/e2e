import { useCallback, useRef } from "react";

type Props = {
  onResize: (delta: number) => void;
  direction: "left" | "right";
};

export function ResizeHandle({ onResize, direction }: Props) {
  const startX = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = direction === "right"
        ? moveEvent.clientX - startX.current
        : startX.current - moveEvent.clientX;
      startX.current = moveEvent.clientX;
      onResize(delta);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [onResize, direction]);

  return <div className="resize-handle" onMouseDown={onMouseDown} />;
}
