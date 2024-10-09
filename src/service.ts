import { Request, Response } from 'express'
import crypto from 'crypto'
import { MongoClient } from 'mongodb'
import { AsyncLock } from './common/common.js'
import Axios from 'axios'
import proxy from 'express-http-proxy'
import amqplib from 'amqplib'
import http from 'http'
import https from 'https'

const axios = Axios.create({
    timeout: 60 * 1000,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
})

export interface Context {
    req: Request,
    res: Response,
    method: string,
    key: string,
    body: any,
    intercept?: boolean
    cache?: boolean
}


const streqi = (x: any, y: any) =>
    typeof x === 'string' && typeof y === 'string' &&
    x.toLowerCase() === y.toLowerCase()


export const transactionTracker = async (rabbitmq: {
    url: string,
    exchange: string,
    routingKey: string,
}) => {
    const conn = await amqplib.connect(rabbitmq.url)
    const ch = await conn.createConfirmChannel()
    ch.assertExchange(rabbitmq.exchange, 'topic', { durable: true })
    const transactionCache: Record<string, boolean> = {

    }

    return async (ctx: Context, next: () => any) => {
        if (
            !streqi(ctx.req?.body?.method, 'sendtransaction') &&
            !streqi(ctx.req?.body?.method, 'gettransaction')
        ) {
            return next()
        }
        ctx.intercept = true
        const maybePromise = next()
        if (maybePromise && maybePromise.then) {
            await maybePromise
        }

        if (!ctx.body || !ctx.body.result || ctx.body.error)
            return

        if (streqi(ctx.req?.body?.method, 'sendtransaction')) {
            const txHash = ctx.body.result
            console.log(`TRACK transaction ${txHash}`)
            transactionCache[txHash] = true
            setTimeout(() => {
                delete transactionCache[txHash]
            }, 5 * 60 * 1000)
            return
        }

        // notify the transaction is completed
        const txHash = ctx.req?.body?.params?.[0]
        console.log(`GETTX hash = ${txHash}`)
        if (!txHash || !transactionCache[txHash]) return

        delete transactionCache[txHash]
        console.log(`${txHash} done`)
        ch.publish(rabbitmq.exchange, rabbitmq.routingKey, Buffer.from(JSON.stringify({
            txHash: txHash,
        }), 'utf8'))
    }

}

export const hashIndexer = (cacheMethods: string[], interceptMethods: string[], ignoreCase?: boolean) => {
    const eq = ignoreCase ? streqi : (x, y) => x === y

    return async (ctx: Context, next: () => any) => {
        ctx.method = ctx.req?.body?.method

        for (const method of interceptMethods) {
            if (ctx.req.body != null && eq(method, ctx.req.body.method)) {
                ctx.intercept = true
                break
            }
        }


        for (const method of cacheMethods) {
            if (ctx.req.body != null && eq(method, ctx.req.body.method)) {
                ctx.cache = true
                ctx.intercept = true
                break
            }
        }

        if (!ctx.cache) {
            console.log(`IGNORE ${ctx.req.body.method}`)
            return next()
        }

        const id = ctx.req.body.id
        ctx.req.body.id = 1
        const key = JSON.stringify(ctx.req.body)
        const hash = crypto.createHash('sha256').update(key).digest('hex')
        ctx.req.body.id = id
        ctx.key = hash
        ctx.method = ctx.req.body.method
        return next()
    }
}


export const mongoCacheProvider = async (url: string, ttls: Record<string, number>) => {
    for (const key of Object.keys(ttls)) {
        ttls[key.toLowerCase()] = ttls[key]
    }

    const conn = new MongoClient(url)
    const lock = new AsyncLock()
    await conn.connect()
    const db = conn.db()

    const colName = (name: string) => `${name}-${ttls[name]}`


    for (const key of Object.keys(ttls)) {
        const name = colName(key)
        const col = db.collection(name)

        if (await col.countDocuments() > 0) continue

        await db.createIndex(
            name,
            {
                createdAt: 1,
            },
            {
                expireAfterSeconds: ttls[key]
            }
        )
    }

    const read = async (key: string, method: string) => {
        const name = colName(method)
        const db = conn.db()
        const col = db.collection(name)
        const mayBeCached = await col.findOne({ _id: <any>key })

        const now = new Date()

        if (mayBeCached && ((now.valueOf() - mayBeCached.createdAt.valueOf()) / 1000) < ttls[method.toLowerCase()]) {
            return mayBeCached.value
        }
        return
    }

    const write = async (key: string, data: any, method: string) => {
        const name = colName(method)
        const db = conn.db()
        const col = db.collection(name)

        await col.updateOne(
            {
                _id: <any>key,
            },
            {
                '$set': {
                    value: data,
                    createdAt: new Date(),
                }
            }, {
            upsert: true
        })
    }

    return async (ctx: Context, next: () => any) => {
        if (!ctx.cache) {
            return next()
        }

        const lockCtx = await lock.lock(ctx.key)

        try {
            const cached = await read(ctx.key, ctx.method)
            if (cached) {
                console.log(`HIT ${ctx.method} key = ${ctx.key}`)
                // modify id
                const resp = {
                    ...cached,
                    id: ctx.req.body.id
                }

                ctx.body = resp
                ctx.res.json(resp)
                return
            }

            console.log(`MISS ${ctx.method} key = ${ctx.key}`)
            const mayBePromise = next()
            if (mayBePromise && mayBePromise.then)
                await mayBePromise

            if (ctx.body && !ctx.body.error && ctx.body.result) {
                console.log(`SAVE ${ctx.method} key = ${ctx.key}`)
                await write(ctx.key, ctx.body, ctx.method)
            }

        } finally {
            lock.unlock(ctx.key, lockCtx)
        }
    }
}

class RateLimiter {
    available: number
    queue: (() => void)[]

    constructor(readonly qps: number) {
        this.available = qps
        this.queue = []
    }

    startFill() {
        setInterval(this.fill.bind(this), 1000)
    }

    fill() {
        this.available = this.qps
        const toWakeUp = Math.min(this.available, this.queue.length)

        for (let i = 0; i < toWakeUp; i++) {
            const fn = this.queue[i]
            fn()
        }

        this.queue = this.queue.slice(toWakeUp, this.queue.length)
    }

    async waitAvailable() {
        while (!this.available) {
            let resolveFn
            const p = new Promise<void>((resolve, reject) => {
                resolveFn = resolve
            })
            this.queue.push(resolveFn)
            console.log(`WAIT`)
            await p
        }

        this.available--
    }
}

export const rateLimiter = (qps: number) => {
    const limit = new RateLimiter(qps)
    limit.startFill()

    return async (ctx: Context, next: () => any) => {
        await limit.waitAvailable()
        return next()
    }
}

export const loadBalancer = (upstreams: { url: string, qps?: number }[]) => {
    let counter = 0
    const rateLimiter: RateLimiter[] = []

    for (let i = 0; i < upstreams.length; i++) {
        if (!upstreams[i].qps) continue

        rateLimiter[i] = new RateLimiter(upstreams[i].qps)
        rateLimiter[i].startFill()
    }

    return async (ctx: Context, next: () => any) => {
        const i = counter
        const upstream = upstreams[i]
        counter = (counter + 1) % upstreams.length
        const limit = rateLimiter[i]

        if (limit) {
            await limit.waitAvailable()
        }

        if (!ctx.intercept) {
            const url = new URL(upstream.url)

            ctx.req.url = url.pathname + url.search
            console.log(`PROXY ${ctx.method} to ${upstream.url}`)
            proxy(`${url.protocol}//${url.host}`)(ctx.req, ctx.res)
            return
        }


        const resp = await axios.post(upstream.url, ctx.req.body)
        ctx.body = resp.data
        ctx.res.json(ctx.body)
    }
}
