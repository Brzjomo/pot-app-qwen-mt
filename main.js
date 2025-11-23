async function translate(text, from, to, options) {
    const { config, utils } = options;
    const { tauriFetch: fetch } = utils;
    let { model = "qwen-mt-flash", apiKey, requestPath } = config;

    if (!requestPath) {
        requestPath = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    }
    if (!/https?:\/\/.+/.test(requestPath)) {
        requestPath = `https://${requestPath}`;
    }
    if (requestPath.endsWith('/')) {
        requestPath = requestPath.slice(0, -1);
    }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
    }

    const body = {
        model,
        messages: [
            {
                "role": "user",
                "content": text
            }
        ]
    }

    const extraBody = {
        "translation_options": {
            "source_lang": from,
            "target_lang": to
        }
    }

    const res = await fetch(requestPath, {
        method: 'POST',
        url: requestPath,
        headers: headers,
        body: {
            type: "Json",
            payload: { ...body, ...extraBody }
        }
    });

    if (res.ok) {
        let result = res.data;
        let translation = result.choices[0].message.content;
        // 清理不必要的标记和空白
        translation = translation.replace(/<\|endofcontent\|>/g, '').trim();
        return translation;
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}
