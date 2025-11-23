async function translate(text, from, to, options) {
    const { config, utils } = options;
    const { tauriFetch: fetch } = utils;
    let { model = "qwen-mt-flash", apiKey, domains, temperature } = config;

    const requestPath = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

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

    if (domains) {
        extraBody.translation_options.domains = domains;
    }

    if (temperature !== undefined && temperature !== null && temperature !== '') {
        try {
            const tempValue = parseFloat(temperature);
            if (!isNaN(tempValue) && tempValue >= 0 && tempValue < 2) {
                extraBody.translation_options.temperature = tempValue;
            } else {
                extraBody.translation_options.temperature = 0.65;
            }
        } catch (e) {
            extraBody.translation_options.temperature = 0.65;
        }
    } else {
        extraBody.translation_options.temperature = 0.65;
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
