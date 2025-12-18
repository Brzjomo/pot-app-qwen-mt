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

    // ================= 4. 术语表加载逻辑 (JSON) =================
    let terms = [];
    if (termsFile && termsFile.trim() !== '') {
        try {
            const fullTermsPath = await resolvePath(termsFile);
            
            // 4.1 主动检查文件是否存在
            let isExists = false;
            try {
                isExists = await exists(fullTermsPath);
            } catch (e) {
                // 如果路径非法或无权限，exists 可能会抛错
                await warn(`[Terms] 检查文件失败: ${e}`);
            }

            // 4.2 如果不存在，自动创建空文件
            if (!isExists) {
                await info(`[Terms] 文件不存在，尝试创建: ${fullTermsPath}`);
                try {
                    // 确保父目录存在（如果是纯文件名，join 后父目录就是 cacheDir，通常已存在）
                    // 写入空数组 []
                    await writeTextFile(fullTermsPath, "[]");
                    await info(`[Terms] 已成功创建空术语表`);
                    isExists = true; 
                } catch (createErr) {
                    await error(`[Terms] 创建失败: ${createErr}。请检查路径权限或 tauri.conf.json 配置。`);
                }
            }

            // 4.3 读取并解析
            if (isExists) {
                const termsContent = await readTextFile(fullTermsPath);
                try {
                    const parsedTerms = JSON.parse(termsContent);
                    if (Array.isArray(parsedTerms)) {
                        terms = parsedTerms;
                        await info(`[Terms] 已加载 ${terms.length} 条术语`);
                    } else {
                        await warn(`[Terms] 格式错误: 内容必须是 JSON 数组，例如 [{"source":"Src","target":"Tgt"}]`);
                    }
                } catch (jsonErr) {
                    await warn(`[Terms] JSON 解析失败: ${jsonErr}`);
                }
            }
        } catch (err) {
            await warn(`[Terms] 处理流程异常: ${err}`);
        }
    }

    // ================= 5. 在线翻译请求 (Qwen API) =================
    const requestPath = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    
    // 构建请求体
    const body = {
        model,
        messages: [{ "role": "user", "content": text }]
    };

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