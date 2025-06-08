// fusion-engine/core/validator/selfTest.ts
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import semver from 'semver';

/**
 * Checks the runtime environment and basic directory existence for Fusion Engine.
 * If any critical issue is found, it logs an error and exits the process.
 */
export function runSelfTest(): void {
    console.log(chalk.blue('\n🚀 Running Fusion Engine Self-Test...'));

    // 1. Check Node.js Version
    const requiredNodeVersion = '>=18.0.0'; // حداقل ورژن نود جی اس مورد نیاز
    if (!semver.satisfies(process.version, requiredNodeVersion)) {
        console.error(
            chalk.red.bold(
                `❌ ERROR: Node.js version ${process.version} is not supported.\n` +
                `Please upgrade to Node.js ${requiredNodeVersion} or higher.`
            )
        );
        process.exit(1); // خروج با کد خطا
    }
    console.log(chalk.green(`✅ Node.js version ${process.version} meets the requirement.`));

    // 2. Verify existence of required directories
    // این مسیرها نسبت به ریشه پروژه Fusion Engine هستند (مثلاً fusion-engine/modules یا fusion-engine/core)
    const requiredDirs = [
        'modules', // جایی که ماژول‌های اصلی Fusion Engine قرار دارن
        'core',    // جایی که هسته و validatorها قرار دارن
        'projects', // پوشه‌ای که پروژه‌های ورودی کاربر احتمالا در آن قرار دارند
    ];

    for (const dir of requiredDirs) {
        const dirPath = path.resolve(process.cwd(), dir); // مسیر مطلق پوشه
        if (!fs.existsSync(dirPath)) {
            console.error(
                chalk.red.bold(
                    `❌ ERROR: Required directory "${dir}" not found at "${dirPath}".\n` +
                    `Please ensure this directory exists in your project root.`
                )
            );
            process.exit(1);
        }
        if (!fs.statSync(dirPath).isDirectory()) {
            console.error(
                chalk.red.bold(
                    `❌ ERROR: "${dirPath}" exists but is not a directory.\n` +
                    `Please ensure it's a valid directory.`
                )
            );
            process.exit(1);
        }
        console.log(chalk.green(`✅ Required directory "${dir}" found.`));
    }

    // 3. Check write access to a temporary directory (optional but good practice)
    const tempDir = path.resolve(process.cwd(), '.fusion_temp');
    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir); // ایجاد پوشه موقت برای تست
        }
        fs.writeFileSync(path.join(tempDir, 'test.txt'), 'test');
        fs.unlinkSync(path.join(tempDir, 'test.txt')); // حذف فایل تست
        fs.rmdirSync(tempDir); // حذف پوشه موقت
        console.log(chalk.green(`✅ Write access to temporary directory confirmed.`));
    } catch (error: any) {
        console.error(
            chalk.red.bold(
                `❌ ERROR: Failed to write to a temporary directory. Check permissions.\n` +
                `Details: ${error.message}`
            )
        );
        process.exit(1);
    }

    console.log(chalk.blue('🎉 Fusion Engine Self-Test completed successfully!\n'));
}

// این قسمت برای زمانی هست که بخوای selfTest رو مستقیماً اجرا کنی
// اما در حالت عادی، index.ts اون رو فراخوانی میکنه.
if (require.main === module) {
    runSelfTest();
}
