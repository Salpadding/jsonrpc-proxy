import compose from 'koa-compose'
import _ from 'lodash'
import express from 'express'
import config from './config.js'


async function main() {
    const middlewares = config[process.env['APP_ENV']]
    const composed = compose(await middlewares())
    const app = express()
    app.use(express.json())

    app.use((req, res) => {
        composed({
            req,
            res,
        })
    })


    const port = process.env['PORT'] || 3000

    app.listen(port, () => {
        console.log(`server listen on ${port}`)
    })
}

main().catch(console.error)

process.on('unhandledRejection', console.error)
