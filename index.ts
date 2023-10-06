import * as Websocket from "ws"

import { ethers } from "ethers";
import * as hre from "hardhat";

import ERC20ABI from './abi/erc20.json'

async function sleep(seconds: number) {
    return await new Promise(resolve=>setTimeout(resolve, seconds * 1000))
}

interface FeeRequest {
    sender: string
    receiver: string
    token: string
    amount: ethers.BigNumber
}

let erc20Token = new ethers.Contract('0x641441c631e2F909700d2f41FD87F0aA6A6b4EDb', ERC20ABI)
class Mutex {
    private isLocked: boolean = false;
    private queue: (() => void)[] = [];
  
    lock(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (this.isLocked) {
          this.queue.push(resolve);
        } else {
          this.isLocked = true;
          resolve();
        }
      });
    }
  
    unlock(): void {
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next && next();
      } else {
        this.isLocked = false;
      }
    }
  }

export default class Fork {

    public blockTime: number
    public rpc: ethers.providers.JsonRpcProvider
    public server: Websocket.Server
    
    private LOCK = new Mutex()

    constructor(
        blockTime: number,
        rpcURL: string,
        port: number
    ) {
        this.rpc = new ethers.providers.JsonRpcProvider(rpcURL)
        console.log(rpcURL)
        this.blockTime = blockTime
        this.server = new Websocket.Server({port})
        
       
    }


    start() {
        console.log("Started fork")
        this.server.on('connection', (s)=>this.handleConnection(s))
        setInterval(()=>this.reset(), this.blockTime * 1000)
    }

    async handleConnection(socket:Websocket) {
        socket.on('message', async(message:string, a) => {
            console.log("Gotten", message)
            await this.LOCK.lock()
            let request:FeeRequest = JSON.parse(message)
            console.log(request)
            let result = await this.handleFeeRequest(request)
            socket.send(result)
            this.LOCK.unlock()
        })

        socket.on('close', async(code: string) => {
            socket.send("Ok!")
        })
    }

    async handleFeeRequest(request: FeeRequest) {
        let fee = 0
        try {
            let signer = await hre.ethers.getImpersonatedSigner(request.sender)
            let receiver = request.receiver


            await Promise.all([
                hre.network.provider.send("hardhat_setBalance", [
                 request.sender,
                    '0x' + (20 ** 18).toString(16)
                ]),
                hre.network.provider.send("hardhat_setBalance", [
                    receiver,
                    '0x' + (20 ** 18).toString(16)
                ])
            ])


            let token = erc20Token.attach(request.token).connect(signer)
            let [poolBalance, prevBalance]: [ethers.BigNumber, ethers.BigNumber] = await Promise.all([token.balanceOf(request.sender), token.balanceOf(receiver)])

            try {

                let amount = poolBalance.mul(1).div(100)
                await (await token.transfer(receiver, amount, { gasLimit: 1000000 })).wait()
                let newBalance = (await token.balanceOf(receiver)).sub(prevBalance)

                let buyFee = Math.round(Number(amount.sub(newBalance)) / Number(amount) * 100)
                buyFee = buyFee < 0 ? 0 : buyFee

                prevBalance = await token.balanceOf(request.sender)
                signer = await hre.ethers.getImpersonatedSigner(receiver)

                amount = newBalance
                await (await token.connect(signer).swapExactTokensForTokens(request.sender, amount, { gasLimit: 1000000 })).wait()
                newBalance = (await token.balanceOf(request.sender)).sub(prevBalance)
                let sellFee = Math.round(Number(amount.sub(newBalance)) / Number(amount) * 100)
                sellFee = sellFee < 0 ? 0 : sellFee

                fee =  buyFee > sellFee ? buyFee : sellFee
                console.log(`${fee} fee calculated for ${request.token} in ${request.sender}`)
            } catch (e) {
                // if tx reverts for any reason, return a 100% fee
                console.log(e, `fee not calculated for ${request.token} in ${request.sender}`)
                fee  = 100
            }
        } catch (e) {
            console.log(e, `fee not calculated for ${request.token} in ${request.sender} 2`)
            fee  = 100
        }
    

         return JSON.stringify({fee})
    }


    async reset() {
        await this.LOCK.lock()
        try {
            let blockNumber = (await this.rpc.getBlockNumber()) - 10
            console.log(`resetting to block ${blockNumber}`)
            let hardhatProvider = hre.network.provider
            await hardhatProvider.request({
                method: "hardhat_reset",
                params: [
                    {
                        forking: {
                            jsonRpcUrl: this.rpc.connection.url,
                            blockNumber: blockNumber,
                        },
                    },
                ],
            })
        } catch (e){
            console.log(e.message, "from fork reset")
        }
       
        this.LOCK.unlock()

    }
}

let a = new Fork(10, "http://49.12.243.207:9933", 8080)

// async function call() {
//     await sleep(20)
//     const fee = await a.handleFeeRequest({
//         amount: ethers.utils.parseUnits("1", 6),
//         receiver: "0xB1df5d63D41b71DF38AfaE270D0Ec476F2DE201F",
//         sender: "0x50497E7181eB9e8CcD70a9c44FB997742149482a", // pair address
//         token: "0xAeaaf0e2c81Af264101B9129C00F4440cCF0F720"
//     })

//     console.log(fee)
// }

// call()
a.start()