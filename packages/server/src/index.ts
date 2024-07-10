import path from 'node:path'
import express from 'express'
import open from 'open'
import os from 'node:os'
import { getStatus, type RunConfig, run, stop } from '@migptgui/controller'
import fse from 'fs-extra'
import fs from 'node:fs/promises'
import { createTTS } from 'mi-gpt-tts'
import { Readable } from 'node:stream'
// import ip from 'ip'
import { type GuiConfig } from '@migptgui/options'
import baseAuth from 'express-basic-auth'
import { nanoid } from 'nanoid'
import _trimEnd from 'lodash/trimEnd.js'

export function runServer(options?: {
  open?: boolean
  port?: number
  users?: Record<string, string>
  staticPath?: string
}) {
  const port = options?.port || 36592

  const defaultBotCwd = path.join(os.homedir(), '.migptgui/default/')

  const isAuth = !!options?.users
  const ttsSecret = nanoid()
  const ttsSecretPath = '/' + ttsSecret
  const ttsPath = ttsSecretPath + '/tts/tts.mp3'

  async function saveConfig(config: GuiConfig) {
    await fse.ensureDir(defaultBotCwd)
    return fs.writeFile(
      path.join(os.homedir(), '.migptgui/default/migptgui.json'),
      JSON.stringify(config),
    )
  }

  const app = express()

  // 用于测试用户填写的对外地址是否正确
  app.post('/ping', (req, res) => {
    res.status(204).send()
  })

  // 小爱音箱会通过这个接口获取语音合成的音频，所以不能给它加 basicAuth
  app.get(ttsPath, (req, res) => {
    // console.log('进入秘密路径的 /tts/tts.mp3')
    if (!tts) {
      res.status(500).send('TTS not initialized')
      return
    }

    const options: Record<string, unknown> = {}
    const nUrl = req.url.replace('+text=', '&text=') // 修正请求 URL
    const url = new URL('http://localhost' + nUrl)
    for (const [key, value] of url.searchParams.entries()) {
      options[key] = value
    }

    // console.log('准备合成语音。参数：', options)

    const audioStream = new Readable({ read() {} })
    options.stream = audioStream

    // console.log('master: 开始合成语音。配置：', options)

    tts(options)

    res.writeHead(200, {
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'audio/mp3',
    })

    audioStream.pipe(res)
  })

  app.use(express.json())

  if (options?.users) {
    app.use(baseAuth({ users: options.users, challenge: true }))
  }

  if (options?.staticPath) {
    app.use(express.static(options.staticPath))
  }

  let tts: ReturnType<typeof createTTS>

  app.get('/api/status', async (req, res) => {
    res.json(getStatus())
  })

  // 测试对外地址是否能连通
  app.post('/api/test', async (req, res) => {
    const testBaseUrl = req.body.url
    // console.log('测试地址：', _trimEnd(testBaseUrl, '/') + '/ping')
    try {
      const fetchRes = await fetch(_trimEnd(testBaseUrl, '/') + '/ping', {
        method: 'POST',
      })
      if (fetchRes.ok) {
        res.json({
          success: true,
        })
      } else {
        res.json({
          success: false,
        })
      }
    } catch (e) {
      res.json({
        success: false,
      })
    }
  })

  app.get('/api/test/audio', (req, res) => {
    // console.log('测试 audio 播放的参数：', req.query)

    const params = req.query as { ttsConfig: string }
    const options = JSON.parse(params.ttsConfig)
    const testTTS = createTTS(options)

    const audioStream = new Readable({ read() {} })
    options.stream = audioStream

    // console.log('master: 开始合成语音。配置：', options)

    testTTS({
      text: '配置成功！',
      stream: audioStream,
      // 关于 defaultSpeaker：
      // mi-gpt-tts 支持三种 tts 服务，但是，这三种服务是耦合在一起的。
      // 举个例子：我同时配置了 edge 和 volcano，如果我不指定 defaultSpeaker，那么 mi-gpt-tts 会默认使用 volcano；
      // 如果我想要使用 edge，那么我需要在配置中指定 defaultSpeaker 为 edge 所支持的 speaker 比如“云希”。
      //
      // 同时，mi-gpt-tts 会将第一次调用的 defaultSpeaker 作为之后所有朗读的 speaker，举个例子，如果我第一次朗读时 defaultSpeaker 为“云希”，
      // 那么之后所有的朗读都会使用 edge，如果我在这之后把 defaultSpeaker 切换为了 volcano 的“灿灿”，它仍然是用 edge 的“云希”朗读的。
      // 为了解决这个问题，需要每次调用都指定下面的 speaker，这个可以强制要求 mi-gpt-tts 使用指定的 speaker。
      speaker: options.defaultSpeaker,
    })

    res.writeHead(200, {
      'Transfer-Encoding': 'chunked',
      'Content-Type': 'audio/mp3',
    })

    audioStream.pipe(res)
  })

  // 在自己运行 tts 服务时需要有一个局域网或公网 IP 地址给小爱音箱来访问下面的 /tts/tts.mp3 接口
  // app.get('/api/myip', (req, res) => {
  //   res.json({ ip: ip.address('public') })
  // })

  // 读取配置
  app.get('/api/default', async (req, res) => {
    let migptConfig: GuiConfig | undefined

    try {
      const migptConfigStr = await fs.readFile(
        path.join(defaultBotCwd, 'migptgui.json'),
        'utf-8',
      )
      migptConfig = JSON.parse(migptConfigStr)
    } catch (e) {
      // console.log('master: 读取默认配置文件失败：', e)
    }
    if (migptConfig) {
      res.json({
        config: migptConfig,
      })
    } else {
      res.json({})
    }
  })

  // 保存配置
  app.put('/api/default', async (req, res) => {
    const migptConfig = req.body as GuiConfig
    await saveConfig(migptConfig)
    res.json({ success: true })
  })

  // 删除 .mi.json 和 .bot.json
  app.delete('/api/default', (req, res) => {
    // console.log('准备删除路径：', path.join(os.homedir(), '.migptgui/default/'))
    Promise.all([
      fse.remove(path.join(defaultBotCwd, '.mi.json')),
      fse.remove(path.join(defaultBotCwd, '.bot.json')),
    ]).then(
      () => {
        res.json({ success: true })
      },
      (err) => {
        res.json({ success: false, error: err })
      },
    )
  })

  // 启动 MiGPT
  app.post('/api/default/start', async (req, res) => {
    const migptConfig = req.body as GuiConfig

    await saveConfig(migptConfig)

    // 如果使用了内置的 TTS 服务
    if (
      migptConfig.config.speaker.tts === 'custom' &&
      migptConfig.gui &&
      migptConfig.gui.ttsProvider !== 'custom' &&
      migptConfig.tts
    ) {
      tts = createTTS(migptConfig.tts)
      migptConfig.env.TTS_BASE_URL = `${_trimEnd(migptConfig.gui.publicURL, '/')}${ttsSecretPath}/tts`
      // console.log(
      //   '内建 TTS 服务地址：',
      //   migptConfig.env.TTS_BASE_URL + '/tts.mp3',
      // )
    }

    // console.log('master: 收到 /api/start', migptConfig)

    await run(migptConfig as RunConfig, defaultBotCwd)

    res.json({ success: true })
  })

  app.post('/api/default/stop', async (req, res) => {
    // console.log('master: 收到 /api/stop')

    await stop()

    res.json({ success: true })
  })

  app.listen(port, () => {
    console.log('端口：', port)
    console.log('登录认证：', isAuth ? '已启用' : '未启用')
    console.log('秘密路径：', '已启用')
    if (options?.open) {
      open(`http://localhost:${port}`)
    }
  })
}
