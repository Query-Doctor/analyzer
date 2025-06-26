SELECT
    u.id AS user_id,
    u.username,
    c.id AS conversation_id,
    c.name AS conversation_name,
    m_latest.content AS latest_unread_message_content,
    m_latest.sent_at AS latest_message_sent_at,
    (SELECT COUNT(msg.id) FROM messages msg WHERE msg.conversation_id = c.id) AS total_messages_in_conversation,
    (SELECT COUNT(msg.id) FROM messages msg WHERE msg.conversation_id = c.id AND msg.sent_at >= NOW() - INTERVAL '30 days') AS messages_last_30_days
FROM
    users u
JOIN
    participants p ON u.id = p.user_id
JOIN
    conversations c ON p.conversation_id = c.id
JOIN LATERAL (
    SELECT
        msg.id,
        msg.content,
        msg.sent_at
    FROM
        messages msg
    WHERE
        msg.conversation_id = c.id
    ORDER BY
        msg.sent_at DESC, msg.id DESC
    LIMIT 1
) AS m_latest ON TRUE
WHERE
    c.is_group_chat = TRUE
    AND (p.last_read_message_id IS NULL OR p.last_read_message_id < m_latest.id)
    AND u.last_active_at >= NOW() - INTERVAL '7 days'
GROUP BY
    u.id, u.username, c.id, c.name, m_latest.id, m_latest.content, m_latest.sent_at
ORDER BY
    u.username, m_latest.sent_at DESC;
