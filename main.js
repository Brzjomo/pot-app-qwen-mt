async function translate(text, from, to, options) {
    // 1. 获取配置和工具
    const { config, utils } = options;
    const { 
        tauriFetch: fetch, 
        Database, 
        readTextFile, 
        writeTextFile, 
        exists,
        cacheDir, 
        join,
        info, warn, error
    } = utils;

    // 2. 读取用户配置
    let { 
        model = "qwen-mt-flash", 
        apiKey, 
        domains, 
        temperature, 
        termsFile, 
        databaseFile, 
        forceOnline 
    } = config;

    // --- 辅助函数：智能路径解析 ---
    // 作用：将用户输入的文件名自动转换为 AppCache 目录下的绝对路径
    const resolvePath = async (fileName) => {
        if (!fileName) return null;
        
        // 如果包含斜杠，说明用户填了路径（可能是绝对路径），给予警告
        if (fileName.includes('/') || fileName.includes('\\')) {
            await warn(`[Config] 检测到路径配置: "${fileName}"。请确保该路径在 tauri.conf.json 的 fs scope 允许范围内，否则建议仅填写文件名（将自动存入缓存目录）。`);
            return fileName; 
        }
        
        // 自动拼接缓存目录 (推荐)
        if (join) {
            return await join(cacheDir, fileName);
        }
        return `${cacheDir}/${fileName}`;
    };

    const forceOnlineBool = forceOnline === 'true';

    // ================= 3. 数据库缓存逻辑 (SQLite) =================
    let cachedTranslation = null;
    let db = null; 
    
    if (databaseFile && databaseFile.trim() !== '') {
        try {
            const fullDbPath = await resolvePath(databaseFile);
            
            // 连接数据库
            db = await Database.load(`sqlite:${fullDbPath}`);
            
            // 初始化表结构
            await db.execute(`
                CREATE TABLE IF NOT EXISTS translations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_text TEXT NOT NULL,
                    source_lang TEXT NOT NULL,
                    target_lang TEXT NOT NULL,
                    translated_text TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(source_text, source_lang, target_lang)
                )
            `);

            if (!forceOnlineBool) {
                // 查询缓存
                const result = await db.select(`
                    SELECT translated_text FROM translations
                    WHERE source_text = ? AND source_lang = ? AND target_lang = ?
                `, [text, from, to]);

                if (result && result.length > 0) {
                    cachedTranslation = result[0].translated_text;
                    await info(`[翻译来源] DATABASE (Cache Hit)`);
                    return cachedTranslation; // <--- 命中缓存，直接返回
                } else {
                    await info(`[翻译来源] Cache Miss`);
                }
            } else {
                await info(`[翻译来源] Forced Online (Skip Cache)`);
            }
        } catch (err) {
            await warn(`[Database Error] 初始化或查询失败: ${err}`);
            // 数据库出错不应阻断翻译，继续执行后续在线逻辑
        }
    }

    // ================= 4. 术语表加载逻辑 (SQLite) =================
    let terms = [];
    let termsDb = null;

    if (termsFile && termsFile.trim() !== '') {
        try {
            const fullTermsPath = await resolvePath(termsFile);

            // 4.1 检查文件是否存在
            let fileExists = false;
            try {
                fileExists = await exists(fullTermsPath);
            } catch (e) {
                await warn(`[Terms] 检查文件失败: ${e}`);
            }

            // 4.2 检测文件格式并初始化数据库
            let needMigration = false;
            let jsonTerms = [];

            if (fileExists) {
                // 尝试读取文件内容检测是否为JSON格式
                try {
                    const fileContent = await readTextFile(fullTermsPath);
                    const parsed = JSON.parse(fileContent);
                    if (Array.isArray(parsed)) {
                        // 文件是JSON格式，保存术语数据用于迁移
                        jsonTerms = parsed;
                        needMigration = true;
                        await info(`[Terms] 检测到JSON格式术语表，包含 ${jsonTerms.length} 条术语`);
                    }
                } catch (jsonErr) {
                    // 不是JSON格式，可能是SQLite数据库或损坏的文件
                    // 继续尝试作为SQLite数据库打开
                }
            }

            // 4.3 连接术语表数据库
            // 如果文件是JSON格式，Database.load可能会失败，但我们仍然尝试
            try {
                termsDb = await Database.load(`sqlite:${fullTermsPath}`);
            } catch (dbErr) {
                // 数据库连接失败，可能是文件格式不正确
                await warn(`[Terms] SQLite数据库连接失败: ${dbErr}`);
                termsDb = null;
            }

            // 4.4 如果数据库连接成功，初始化表结构
            if (termsDb) {
                await termsDb.execute(`
                    CREATE TABLE IF NOT EXISTS terms (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        source TEXT NOT NULL,
                        target TEXT NOT NULL,
                        case_sensitive BOOLEAN DEFAULT 0,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(source)
                    )
                `);

                // 4.5 如果需要迁移JSON数据
                if (needMigration && jsonTerms.length > 0) {
                    await info(`[Terms] 开始迁移JSON术语到SQLite数据库...`);
                    let migratedCount = 0;
                    for (const term of jsonTerms) {
                        if (term.source && term.target) {
                            try {
                                await termsDb.execute(
                                    `INSERT OR IGNORE INTO terms (source, target) VALUES (?, ?)`,
                                    [term.source, term.target]
                                );
                                migratedCount++;
                            } catch (insertErr) {
                                // 忽略重复项错误
                            }
                        }
                    }
                    await info(`[Terms] 已迁移 ${migratedCount} 条术语到SQLite数据库`);
                }

                await info(`[Terms] SQLite术语表数据库已就绪`);
            } else if (needMigration) {
                // 数据库连接失败但有JSON数据，无法迁移
                await warn(`[Terms] 无法创建SQLite数据库，术语表功能将不可用`);
            }

        } catch (err) {
            await warn(`[Terms] 术语表初始化失败: ${err}`);
            termsDb = null;
        }
    }

    // ================= 5. 在线翻译请求 (Qwen API) =================
    const requestPath = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    
    // 构建请求体
    const body = {
        model,
        messages: [{ "role": "user", "content": text }]
    };

    // 术语匹配逻辑：从数据库中查找匹配的术语
    let matchedTerms = [];
    if (termsDb) {
        try {
            // 从数据库加载所有术语
            const allTerms = await termsDb.select(`SELECT source, target, case_sensitive FROM terms`);
            await info(`[Terms] 从数据库加载了 ${allTerms.length} 条术语`);

            // 在文本中查找匹配的术语（支持单词边界和大小写敏感度）
            for (const term of allTerms) {
                const source = term.source;
                const caseSensitive = term.case_sensitive === 1;

                let isMatch = false;

                // 构建正则表达式进行单词边界匹配
                // 转义正则表达式特殊字符
                const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regexPattern = `\\b${escapedSource}\\b`;
                const regexFlags = caseSensitive ? '' : 'i';

                try {
                    const regex = new RegExp(regexPattern, regexFlags);
                    isMatch = regex.test(text);
                } catch (regexErr) {
                    // 如果正则表达式构建失败，回退到简单包含匹配
                    if (caseSensitive) {
                        isMatch = text.includes(source);
                    } else {
                        isMatch = text.toLowerCase().includes(source.toLowerCase());
                    }
                }

                if (isMatch) {
                    matchedTerms.push({
                        source: term.source,
                        target: term.target
                    });
                }
            }

            await info(`[Terms] 找到 ${matchedTerms.length} 条匹配术语`);
        } catch (err) {
            await warn(`[Terms] 术语匹配失败: ${err}`);
        }
    }

    // 如果没有术语数据库或匹配失败，回退到空数组
    terms = matchedTerms;

    // 构建翻译专用参数
    const extraBody = {
        "translation_options": {
            "source_lang": from,
            "target_lang": to,
            "temperature": parseFloat(temperature) || 0.65
        }
    };

    // 注入术语表和领域
    if (terms.length > 0) extraBody.translation_options.terms = terms;
    if (domains) extraBody.translation_options.domains = domains;

    // 发起 HTTP 请求
    const res = await fetch(requestPath, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: {
            type: "Json",
            payload: { ...body, ...extraBody }
        }
    });

    // ================= 6. 处理响应与写入缓存 =================
    if (res.ok) {
        let result = res.data;
        let translation = result?.choices?.[0]?.message?.content || "";
        
        // 清理可能的特殊标记
        translation = translation.replace(/<\|endofcontent\|>/g, '').trim();
        
        await info(`[翻译来源] ONLINE API`);

        // 写入数据库缓存
        if (db && translation) {
            try {
                await db.execute(`
                    INSERT OR REPLACE INTO translations (source_text, source_lang, target_lang, translated_text)
                    VALUES (?, ?, ?, ?)
                `, [text, from, to, translation]);
                await info(`[Cache] 新翻译已存入数据库`);
            } catch (e) {
                await warn(`[Cache] 写入失败: ${e}`);
            }
        }

        return translation;
    } else {
        // 抛出错误以便 Pot Desktop 前端捕获显示
        const errMsg = `API Error ${res.status}: ${JSON.stringify(res.data)}`;
        await error(errMsg);
        throw errMsg;
    }
}