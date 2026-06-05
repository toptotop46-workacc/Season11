import { setupEncoding } from './encoding-setup.js'
import { KeyEncryption } from './key-encryption.js'
import { logger } from './logger.js'

// Импорт всех модулей
import { performLiquidityManagement as performAaveLiquidity } from './modules/aave.js'
import { performArkadaCheckin } from './modules/arkada-checkin.js'
import { performCollection } from './modules/collector.js'
import { performLootcoinCheckin } from './modules/lootcoin.js'
import { performJumperSwap } from './modules/jumper.js'
import { performMorphoLiquidityManagement } from './modules/morpho.js'
import { performSakeFinanceOperations } from './modules/sake-finance.js'
import { performLiquidityManagement as performStargateLiquidity } from './modules/stargate.js'
import { performDepositManagement } from './modules/untitled-bank.js'
import { performRevoke } from './modules/revoke.js'
import { performHarkan } from './modules/harkan.js'
import { performVelodrome } from './modules/velodrome.js'
import { performWowmax } from './modules/wowmax.js'
import { performCaptainCheckin } from './modules/captain-checkin.js'
import { performMmpFarmPlant, performMmpFarmHarvest } from './modules/mmp-farm.js'
import { performMmpSeedTransfer } from './modules/mmp-seed-transfer.js'
import { performMmpBridgeOut } from './modules/mmp-bridge-out.js'
import { performMmpBridgeIn } from './modules/mmp-bridge-in.js'
import { performMmpQuest } from './modules/mmp-quest.js'
import { performMmpWildModule } from './modules/mmp-wild.js'
import { performBurrowBash } from './modules/burrow-bash.js'
import { performWorldOfTrinity } from './modules/world-of-trinity.js'
import { performStartaleInvite } from './modules/startale-invite.js'
import { performStartaleGm } from './modules/startale-gm.js'

// Интерфейс для результата выполнения модуля
interface ModuleResult {
  success: boolean
  walletAddress?: string
  transactionHash?: string
  explorerUrl?: string | null
  error?: string
  skipped?: boolean // Флаг пропуска кошелька (не ошибка)
  reason?: string // Причина пропуска
  // Дополнительные поля для конкретных модулей
  ethBalance?: string
  swapAmount?: string
  targetToken?: string
  usdcBalance?: string
  aTokenBalance?: string
  morphoBalance?: string
  redeemableBalance?: string
  bankBalance?: string
  streak?: number
  blockNumber?: bigint
  // Поля для Sake Finance
  initialUsdcBalance?: string
  initialATokenBalance?: string
  finalUsdcBalance?: string
  finalATokenBalance?: string
  withdrawTransactionHash?: string | null
  supplyTransactionHash?: string | null
  finalWithdrawTransactionHash?: string | null
  depositAmount?: string
  message?: string
  // Поля для других модулей
  depositTransactionHash?: string
  redeemTransactionHash?: string | null
  withdrawTxHash?: string
  [key: string]: unknown
}

// Типы для модулей
interface Module {
  name: string
  description: string
  execute: (privateKey: `0x${string}`) => Promise<ModuleResult>
}

// Список всех доступных модулей
const modules: Record<string, Module> = {
  'aave': {
    name: 'Aave',
    description: 'Управление ликвидностью в протоколе Aave',
    execute: performAaveLiquidity
  },
  'arkada-checkin': {
    name: 'Arkada Check-in',
    description: 'Ежедневный check-in в Arkada',
    execute: performArkadaCheckin
  },
  'lootcoin': {
    name: 'Lootcoin Check-in',
    description: 'Ежедневный check-in в Lootcoin',
    execute: performLootcoinCheckin
  },
  'collector': {
    name: 'Collector',
    description: 'Сбор токенов и проверка ликвидности во всех протоколах',
    execute: performCollection
  },
  'jumper': {
    name: 'Jumper',
    description: 'Свапы токенов через LI.FI',
    execute: performJumperSwap
  },
  'morpho': {
    name: 'Morpho',
    description: 'Управление ликвидностью в протоколе Morpho',
    execute: performMorphoLiquidityManagement
  },
  'sake-finance': {
    name: 'Sake Finance',
    description: 'Операции в протоколе Sake Finance',
    execute: performSakeFinanceOperations
  },
  'stargate': {
    name: 'Stargate',
    description: 'Управление ликвидностью в протоколе Stargate',
    execute: performStargateLiquidity
  },
  'untitled-bank': {
    name: 'Untitled Bank',
    description: 'Управление депозитами в Untitled Bank',
    execute: performDepositManagement
  },
  'revoke': {
    name: 'Revoke',
    description: 'Отзыв всех апрувов для кошелька',
    execute: performRevoke
  },
  'harkan': {
    name: 'Harkan',
    description: 'Один спин в Harkan (cyber-roulette)',
    execute: performHarkan
  },
  'velodrome': {
    name: 'Velodrome',
    description: 'Свап ETH → USDC.e (0.1–1% от баланса) через Velodrome',
    execute: performVelodrome
  },
  'wowmax': {
    name: 'WOWMAX',
    description: 'Свап ETH → USDC.e (0.1–1% от баланса) через WOWMAX',
    execute: performWowmax
  },
  'captain-checkin': {
    name: 'Captain Check-in',
    description: 'Ежедневный check-in в Captain',
    execute: performCaptainCheckin
  },
  'mmp-farm': {
    name: 'MMP Farm Plant',
    description: 'Morning Moon Pocket: посадка семян (квест Soneium S10 plant 3 corn seeds)',
    execute: performMmpFarmPlant
  },
  'mmp-harvest': {
    name: 'MMP Farm Harvest',
    description: 'Morning Moon Pocket: harvest на ферме (сбор наград или очистка увядшего)',
    execute: performMmpFarmHarvest
  },
  'mmp-seed-transfer': {
    name: 'MMP Seed Transfer',
    description: 'Раздача CORN_SEED от донорского кошелька воркерам (env MMP_DONOR_PRIVATE_KEY)',
    execute: performMmpSeedTransfer
  },
  'mmp-bridge-out': {
    name: 'MMP Bridge OUT',
    description: 'Bridge OUT: in-game items → on-chain ERC-20 (Escrow.deposit + /inventory/exports)',
    execute: performMmpBridgeOut
  },
  'mmp-bridge-in': {
    name: 'MMP Bridge IN',
    description: 'Bridge IN: on-chain ERC-20 → in-game items (Escrow.deposit + /inventory/imports)',
    execute: performMmpBridgeIn
  },
  'mmp-quest': {
    name: 'MMP Quest',
    description: 'Полный квест Soneium S10: signup→tutorial→craft→stake (skipped если ресурсы wild не собраны)',
    execute: performMmpQuest
  },
  'mmp-wild': {
    name: 'MMP Wild Zone',
    description: 'Morning Moon Pocket: автоматический сбор wood/stone через wild-zone (15 wood + 45 stone)',
    execute: performMmpWildModule
  },
  'burrow-bash': {
    name: 'Burrow Bash',
    description: 'Burrow Bash: createGame для квеста "Play 10 games" (1 tx за вызов, проверка через portal)',
    execute: performBurrowBash
  },
  'world-of-trinity': {
    name: 'World of Trinity',
    description: 'World of Trinity: 1 battle через WS matchmaking + AutoLose (квест Join 3 games)',
    execute: performWorldOfTrinity
  },
  'startale-invite': {
    name: 'Startale Invite',
    description: 'Реферальный квест Startale (startale_10/quests[1]): SIWE auth main → invitee + referrer_code → portal polling',
    execute: performStartaleInvite
  },
  'startale-gm': {
    name: 'Startale GM',
    description: 'Ежедневный GM на Startale (startale_10/quests[0]): прямой checkIn() от EOA (стоп при 10/10 в сезоне)',
    execute: performStartaleGm
  }
}

/**
 * Получает случайный приватный ключ из хранилища (зашифрованного или открытого)
 */
async function getRandomPrivateKey (): Promise<`0x${string}`> {
  try {
    let privateKeys: string[] = []

    if (KeyEncryption.hasEncryptedKeys()) {
      privateKeys = await KeyEncryption.promptPasswordWithRetry()
    } else if (KeyEncryption.hasPlainKeys()) {
      privateKeys = await KeyEncryption.loadPlainKeys()
    } else {
      throw new Error('Не найдено ключей')
    }

    if (privateKeys.length === 0) {
      throw new Error('Не найдено приватных ключей')
    }

    const randomIndex = Math.floor(Math.random() * privateKeys.length)
    const selectedKey = privateKeys[randomIndex]!

    return selectedKey as `0x${string}`
  } catch (error) {
    logger.error('Ошибка при получении приватного ключа', error)
    throw error
  }
}

/**
 * Выполняет указанный модуль
 */
async function executeModule (moduleName: string): Promise<void> {
  try {
    logger.moduleStart(moduleName)

    // Проверяем существование модуля
    const module = modules[moduleName]
    if (!module) {
      logger.error(`Модуль '${moduleName}' не найден!`)
      logger.info('Доступные модули:')
      Object.keys(modules).forEach(name => {
        logger.info(`  - ${name}`)
      })
      return
    }

    const privateKey = await getRandomPrivateKey()

    const startTime = Date.now()
    const result = await module.execute(privateKey)
    const endTime = Date.now()
    const executionTime = (endTime - startTime) / 1000

    // Если кошелек пропущен (skipped), это не ошибка
    const isSkipped = result.skipped === true
    const isSuccess = result.success || isSkipped

    logger.moduleEnd(moduleName, isSuccess, executionTime)

  } catch (error) {
    logger.moduleEnd(moduleName, false)
    logger.error('Критическая ошибка выполнения модуля', error)
  }
}

/**
 * Показывает список всех доступных модулей
 */
function showAvailableModules (): void {
  logger.info('Доступные модули: ' + Object.keys(modules).join(', '))
}

/**
 * Основная функция для запуска модуля
 */
async function main (): Promise<void> {
  try {
    // Настройка кодировки для корректного отображения кириллицы
    setupEncoding()

    // Получаем имя модуля из аргументов командной строки
    const moduleName = process.argv[2]

    if (!moduleName) {
      showAvailableModules()
      logger.info('Использование: npm run <module-name>')
      return
    }

    // Проверяем и предлагаем шифрование ключей
    const shouldExit = await KeyEncryption.checkAndOfferEncryption()
    if (shouldExit) {
      return
    }

    if (!KeyEncryption.hasEncryptedKeys() && !KeyEncryption.hasPlainKeys()) {
      logger.error('Не найдены ключи. Создайте файл keys.txt с приватными ключами.')
      return
    }

    // Выполняем указанный модуль
    await executeModule(moduleName)

  } catch (error) {
    logger.error('Критическая ошибка приложения', error)
    process.exit(1)
  }
}

process.on('SIGINT', () => {
  process.exit(0)
})

process.on('SIGTERM', () => {
  process.exit(0)
})

main().catch((error) => {
  logger.error('Необработанная ошибка', error)
  process.exit(1)
})
