// Pure eligibility decisions; persistence and scheduling belong to the host.
export function evaluateTurn({completedRuns, contentLength, messageCount, toolCallCount, writerEnabled = true, reflectionEnabled = true, harvestEnabled = true}) {
  for (const n of [completedRuns, contentLength, messageCount, toolCallCount]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_TURN_COUNTS');
  }
  return {
    writer: writerEnabled && completedRuns > 0 && completedRuns % 10 === 0 && contentLength >= 100,
    reflection: reflectionEnabled && messageCount >= 2,
    harvest: harvestEnabled && messageCount > 5 && toolCallCount >= 15,
  };
}
