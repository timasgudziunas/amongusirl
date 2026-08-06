// Shared between GET /api/state (live validation shown in the host panel) and
// POST /api/start-round (the actual gate). Keep these in sync — never hardcode
// player/imposter/task counts anywhere that uses this.

export type StartValidation = { canStart: boolean; errors: string[] };

export function computeStartValidation(
  playerCount: number,
  taskCount: number,
  imposterCount: number,
  tasksPerPlayer: number | null
): StartValidation {
  const errors: string[] = [];

  if (imposterCount < 1) {
    errors.push("Need at least 1 imposter.");
  }
  if (imposterCount * 2 >= playerCount) {
    errors.push("Imposters must be fewer than half the players in the lobby.");
  }
  if (taskCount < 1) {
    errors.push("Add at least 1 task before starting.");
  }
  if (tasksPerPlayer !== null && (tasksPerPlayer < 1 || tasksPerPlayer > taskCount)) {
    errors.push("Tasks per player must be between 1 and the number of tasks.");
  }

  return { canStart: errors.length === 0, errors };
}
