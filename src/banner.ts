/**
 * ANSI заставка для Soneium Automation Bot
 * Красивое ASCII-арт оформление без эмодзи
 */

export class Banner {
  private static readonly COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgBlue: '\x1b[44m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m'
  }

  /**
   * Показать главную заставку
   */
  static show (): void {
    console.clear()
    console.log(this.createMainBanner())
    console.log(this.createSubtitle())
    console.log(this.createSeparator())
    console.log('')
  }

  /**
   * Создать главный баннер
   */
  private static createMainBanner (): string {
    const banner = `
${this.COLORS.cyan}${this.COLORS.bright}
    ███████╗ ██████╗ ███╗   ██╗███████╗ ██╗ ██╗   ██╗███╗   ███╗
    ██╔════╝██╔═══██╗████╗  ██║██╔════╝ ██║ ██║   ██║████╗ ████║
    ███████╗██║   ██║██╔██╗ ██║█████╗   ██║ ██║   ██║██╔████╔██║
    ╚════██║██║   ██║██║╚██╗██║██╔══╝   ██║ ██║   ██║██║╚██╔╝██║
    ███████║╚██████╔╝██║ ╚████║███████╗ ██║ ╚██████╔╝██║ ╚═╝ ██║
    ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝ ╚═╝  ╚═════╝ ╚═╝     ╚═╝
${this.COLORS.reset}`
    return banner
  }

  /**
   * Создать подзаголовок
   */
  private static createSubtitle (): string {
    const subtitle = `
${this.COLORS.yellow}${this.COLORS.bright}                         AUTOMATION BOT v11.0.0${this.COLORS.reset}
${this.COLORS.dim}                     https://t.me/privatekey7${this.COLORS.reset}`
    return subtitle
  }

  /**
   * Создать разделитель
   */
  private static createSeparator (): string {
    const separator = `${this.COLORS.blue}${'='.repeat(70)}${this.COLORS.reset}`
    return separator
  }

  /**
   * Создать прогресс-бар с анимацией
   */
  static createProgressBar (current: number, total: number, width: number = 50): string {
    const percentage = Math.round((current / total) * 100)
    const filled = Math.round((current / total) * width)
    const empty = width - filled

    const bar = `${this.COLORS.green}${'█'.repeat(filled)}${this.COLORS.dim}${'░'.repeat(empty)}${this.COLORS.reset}`
    return `[${bar}] ${percentage}% (${current}/${total})`
  }
}
