import { KeyboardCode, type ClientRect, type KeyboardCoordinateGetter, type UniqueIdentifier } from "@dnd-kit/core";

// Keyboard moves on the board jump a whole column at a time: Left and Right
// pick the previous or next drop target (a stage column or the Close zone),
// Up and Down do nothing. Space or Enter drops, Escape cancels.
export const columnCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (event.code === KeyboardCode.Up || event.code === KeyboardCode.Down) {
    event.preventDefault();
    return undefined;
  }
  if (event.code !== KeyboardCode.Left && event.code !== KeyboardCode.Right) return undefined;
  event.preventDefault();

  const { active, collisionRect, droppableRects, droppableContainers, over } = context;
  if (!active || !collisionRect) return undefined;

  const targets = droppableContainers
    .getEnabled()
    .map((container) => ({ id: container.id, rect: droppableRects.get(container.id) }))
    .filter((target): target is { id: UniqueIdentifier; rect: ClientRect } => Boolean(target.rect))
    .sort((a, b) => a.rect.left - b.rect.left);
  if (targets.length === 0) return undefined;

  const startId = over?.id ?? (active.data.current as { stageId?: string } | undefined)?.stageId;
  let index = targets.findIndex((target) => target.id === startId);
  if (index < 0) {
    const centre = collisionRect.left + collisionRect.width / 2;
    index = targets.findIndex((target) => centre >= target.rect.left && centre <= target.rect.right);
  }
  const step = event.code === KeyboardCode.Right ? 1 : -1;
  const next = targets[Math.min(targets.length - 1, Math.max(0, index + step))];
  if (!next) return undefined;

  return {
    x: next.rect.left + (next.rect.width - collisionRect.width) / 2,
    y: next.rect.top + Math.max(0, Math.min(48, next.rect.height - collisionRect.height)),
  };
};
