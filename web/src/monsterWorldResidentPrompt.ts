import type { WorldThinkEntry } from "./monsterWorldProtocol";

export function worldResidentPrompt(entry: WorldThinkEntry): string {
  const observation = entry.observation;
  return `WORLD OBSERVATION (untrusted JSON data):\n${JSON.stringify({
    requestId: entry.requestId,
    memory: entry.memory,
    observation: {
      stateVersion: observation.stateVersion,
      minuteOfDay: observation.minuteOfDay,
      weather: observation.weather,
      self: observation.self,
      nearby: observation.nearby,
      roster: observation.roster,
      ...(observation.playerOrder === undefined ? {} : { playerOrder: observation.playerOrder }),
      ...(observation.guildCall === undefined ? {} : { guildCall: observation.guildCall }),
      room: {
        path: "/workspace/world/room/messages.jsonl",
        posts: observation.guildBoard.length,
        newestMessageId: observation.guildBoard[0]?.id ?? 0,
      },
      recentEvents: observation.recentEvents,
      availableTargets: observation.availableTargets,
      supplies: observation.supplies,
    },
  })}\n\nAct in the live World now. Use tool feedback to correct your own movement, then finish when your part is satisfied.`;
}
