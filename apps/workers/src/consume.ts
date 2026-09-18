import {
  CONSUMER_GROUPS,
  parseEvent,
  type DomainEvent,
} from "@startup-logistica/shared";
import { redis } from "./redis.js";

type Handler = (event: DomainEvent, id: string) => Promise<void>;

export async function consumeStream(opts: {
  stream: string;
  group: string;
  consumer: string;
  handler: Handler;
}) {
  const client = redis.duplicate();

  try {
    await client.xgroup("CREATE", opts.stream, opts.group, "0", "MKSTREAM");
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("BUSYGROUP")) throw err;
  }

  const loop = async () => {
    while (true) {
      try {
        const res = (await client.xreadgroup(
          "GROUP",
          opts.group,
          opts.consumer,
          "COUNT",
          10,
          "BLOCK",
          5000,
          "STREAMS",
          opts.stream,
          ">",
        )) as [string, [string, string[]][]][] | null;

        if (!res) continue;
        for (const [, messages] of res) {
          for (const [id, fieldArr] of messages) {
            const fields: Record<string, string> = {};
            for (let i = 0; i < fieldArr.length; i += 2) {
              fields[fieldArr[i]] = fieldArr[i + 1];
            }
            try {
              await opts.handler(parseEvent(fields), id);
              await client.xack(opts.stream, opts.group, id);
            } catch (err) {
              console.error(`[${opts.group}] fallo ${id}`, err);
            }
          }
        }
      } catch (err) {
        console.error(`[${opts.group}] xreadgroup`, err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  void loop();
  console.log(`consumer ${opts.consumer} en ${opts.stream} (${opts.group})`);
}

export { CONSUMER_GROUPS };
