import { execSync } from 'child_process'
import { env } from 'process'
import { logger } from './logger.js'

/**
 * Настройка кодировки для всех платформ
 * Обеспечивает корректное отображение кириллицы в консоли
 */
export function setupEncoding (): void {
  try {
    // Установка кодировки stdout и stderr в UTF-8
    if (process.stdout.setEncoding) {
      process.stdout.setEncoding('utf8')
    }
    if (process.stderr.setEncoding) {
      process.stderr.setEncoding('utf8')
    }

    // Настройка кодировки в зависимости от платформы
    if (process.platform === 'win32') {
      // Windows: установка кодировки консоли в UTF-8
      try {
        execSync('chcp 65001', { stdio: 'ignore' })
      } catch {
        // Игнорируем ошибки chcp, если команда недоступна
        logger.warn('Предупреждение: не удалось установить кодировку UTF-8')
      }
    } else if (process.platform === 'darwin') {
      // macOS: установка переменных окружения для UTF-8
      env['LANG'] = 'ru_RU.UTF-8'
      env['LC_ALL'] = 'ru_RU.UTF-8'
      env['LC_CTYPE'] = 'ru_RU.UTF-8'
    } else if (process.platform === 'linux') {
      // Linux: установка переменных окружения для UTF-8
      env['LANG'] = 'ru_RU.UTF-8'
      env['LC_ALL'] = 'ru_RU.UTF-8'
      env['LC_CTYPE'] = 'ru_RU.UTF-8'
    }

    // Универсальная настройка переменных окружения
    env['NODE_OPTIONS'] = '--max-old-space-size=4096'

    // Дополнительные настройки для Windows
    if (process.platform === 'win32') {
      env['PYTHONIOENCODING'] = 'utf-8'
      env['PYTHONLEGACYWINDOWSSTDIO'] = '1'
    }

  } catch (error) {
    logger.error('Ошибка при настройке кодировки', error)
  }
}
