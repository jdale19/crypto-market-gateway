// /api/health.js
import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  const ts = Date.now();

  const hasRedisEnv =
    !!process.env.UPSTASH_REDIS_REST_URL &&
    !!process.env.UPSTASH_REDIS_REST_TOKEN;

  let redisOk = false;
  let redisError = null;

  if (hasRedisEnv) {
    try {
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });

      await redis.ping();
      redisOk = true;
    } catch (err) {
      redisError = String(err?.message || err);
    }
  }

  const ok = hasRedisEnv && redisOk;

  res.setHeader("Cache-Control", "no-store");
  return res.status(ok ? 200 : 500).json({
    ok,
    ts,
    version: "v3",
    redis: {
      env_present: hasRedisEnv,
      reachable: redisOk,
      error: redisError,
    },
  });
}