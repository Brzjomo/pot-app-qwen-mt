async function translate(text, from, to, options) {
    const { config, utils } = options;
    const { 
        tauriFetch: fetch, 
        Database, 
        readTextFile, 
        writeTextFile, 
        exists,
        createDir,
        cacheDir, 
        join,
        info, warn, error
    } = utils;

    let { model = "qwen-mt-flash", apiKey, domains, temperature, termsFile, databaseFile, forceOnline } = config;

    // --- 辅助函数：处理路径 ---
    const resolvePath = async (base, filePath) => {
        if (!filePath) return null;
        // 警告：如果用户填了绝对路径（如 C:/...），必须在 tauri.conf.json 的允许范围内，否则会报错
        if (filePath.includes('/') || filePath.includes('\\')) return filePath; 
        if (join) return await join(base, filePath);
        return `${base}/${filePath}`;
    };

    const forceOnlineBool = forceOnline === 'true';

    // ================= 数据库逻辑 =================
    let cachedTranslation = null;
    let db = null; 
    if (databaseFile && databaseFile.trim() !== '') {
        try {
            const fullDbPath = await resolvePath(cacheDir, databaseFile);
            db = await Database.load(`sqlite:${fullDbPath}`);
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
                const result = await db.select(`
                    SELECT translated_text FROM translations
                    WHERE source_text = ? AND source_lang = ? AND target_lang = ?
                `, [text, from, to]);

                if (result && result.length > 0) {
                    cachedTranslation = result[0].translated_text;
                    await info(`[翻译来源] DATABASE (缓存命中)`);
                    return cachedTranslation;
                } else {
                    await info(`[翻译来源] 缓存未命中`);
                }
            } else {
                await info(`[翻译来源] 强制在线翻译，跳过缓存`);
            }
        } catch (err) {
            await warn(`数据库初始化或查询失败: ${err}`);
        }
    }

    // ================= 术语表逻辑 (核心修复) =================
    let terms = [];
    if (termsFile && termsFile.trim() !== '') {
        try {
            const fullTermsPath = await resolvePath(cacheDir, termsFile);
            
            // 1. 主动检查文件是否存在
            const isExists = await exists(fullTermsPath).catch(e => {
                warn(`检查文件存在性失败 (可能是权限问题): ${e}`);
                return false; 
            });

            if (!isExists) {
                await info(`术语表不存在: ${fullTermsPath}，尝试创建...`);
                try {
                    // 尝试写入空数组
                    await writeTextFile(fullTermsPath, "[]");
                    await info(`已成功创建术语表文件`);
                } catch (createErr) {
                    await error(`创建术语表失败: ${createErr}。请检查路径是否在允许的范围内 ($APPCACHE)`);
                }
            }

            // 2. 读取文件
            if (await exists(fullTermsPath)) {
                const termsContent = await readTextFile(fullTermsPath);
                try {
                    const parsedTerms = JSON.parse(termsContent);
                    if (Array.isArray(parsedTerms)) {
                        terms = parsedTerms;
                        await info(`加载了 ${terms.length} 条术语`);
                    } else {
                        await warn(`术语表格式错误: 必须是 JSON 数组`);
                    }
                } catch (jsonErr) {
                    await warn(`术语表 JSON 解析失败: ${jsonErr}`);
                }
            }
        } catch (err) {
            await warn(`术语表处理流程异常: ${err}`);
        }
    }

    // ================= 在线翻译请求 =================
    const requestPath = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    const body = {
        model,
        messages: [{ "role": "user", "content": text }]
    };
    const extraBody = {
        "translation_options": {
            "source_lang": from,
            "target_lang": to,
            "temperature": parseFloat(temperature) || 0.65
        }
    };
    if (terms.length > 0) extraBody.translation_options.terms = terms;
    if (domains) extraBody.translation_options.domains = domains;

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

    if (res.ok) {
        let translation = res.data?.choices?.[0]?.message?.content || "";
        translation = translation.replace(/<\|endofcontent\|>/g, '').trim();
        await info(`[翻译来源] ONLINE API`);

        // 写入缓存
        if (db && translation) {
            try {
                await db.execute(`
                    INSERT OR REPLACE INTO translations (source_text, source_lang, target_lang, translated_text)
                    VALUES (?, ?, ?, ?)
                `, [text, from, to, translation]);
                await info(`[Cache] 已缓存翻译结果`);
            } catch (e) {
                await warn(`[Cache] 写入失败: ${e}`);
            }
        }
        return translation;
    } else {
        throw `API Error ${res.status}: ${JSON.stringify(res.data)}`;
    }
}