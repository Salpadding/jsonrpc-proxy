const solana = require('@solana/web3.js')

const localRpc = `http://localhost:${process.env.PORT || 3000}`
const conn = new solana.Connection(localRpc)

async function main() {
    for (let i = 0; i < 100; i++) {
        const account = await conn.getAccountInfo(
            new solana.PublicKey('2gmdtkDS4K3oeExu8Zsj5Wmpxf8DytaZuz19hYezDXAh')
        )
        console.log(i)
    }
}

main().catch(console.error)
