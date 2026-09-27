import fs from 'fs'
import path, { dirname } from 'path'
import pngToIco from 'png-to-ico'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const inputPath = path.join(__dirname, '../simple-ide.png')
const outputPath = path.join(__dirname, '../assets/icon.ico')

async function convertIcon() {
  console.log('Generating icon...')
  try {
    if (!fs.existsSync(inputPath)) {
      console.error(`Error: Could not find ${inputPath}`)
      console.error('Please make sure simple-ide.png exists in the root directory.')
      process.exit(1)
    }

    const buf = await pngToIco(inputPath)
    
    const assetsDir = path.dirname(outputPath)
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true })
    }

    fs.writeFileSync(outputPath, buf)
    console.log('✅ Successfully generated assets/icon.ico from simple-ide.png')
  } catch (err) {
    console.error('❌ Failed to convert icon:', err)
    process.exit(1)
  }
}

convertIcon()
