import { uptime } from 'process'
import { Context } from './service.js'
import { hashIndexer, mongoCacheProvider, transactionTracker, loadBalancer } from './service.js'

type Middleware = (ctx: Context, next: () => any) => any

const upstreams = process.env['JSONRPC_UPSTREAMS'].split(' ').filter(x => x)

const production = async () => {
    const ttls = {
        getblock: 24 * 3600,
        getslot: 3,
        'getlatestblockhash': 3,
        'getaccountinfo': 1,
        'gettransaction': 5 * 60
    }

    const cacheMethods = Object.keys(ttls)
    const interceptMethods = [...cacheMethods, 'sendtransaction', 'gettransaction']

    const middlewares = [
        hashIndexer(cacheMethods, interceptMethods, true),
        await mongoCacheProvider(process.env['MONGODB_URL'] || 'mongodb://localhost:27017/jsonrpc-proxy', ttls),
        await transactionTracker({
            url: process.env['RABBITMQ_URL'] || 'amqp://guest:guest@localhost:5672', exchange: process.env['RABBITMQ_EXCHANGE'] || 'jsonrpc-proxy-tx',
            routingKey: process.env['RABBITMQ_ROUTING_KEY'] || 'tx.done'
        }
        ),
        loadBalancer(upstreams.map(x => ({
            url: x,
            qps: 25,
        })))
    ]

    return middlewares
}

const environments: Record<string, () => Promise<Middleware[]>> = {
    production: production,
    prod: production
}

export default environments
