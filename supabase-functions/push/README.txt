push: web push for Bloom staff (deployed 17 Nov 2026, verify_jwt off; it checks the user token itself,
and the database calls it with x-hook-secret from public.push_private).
Database side: push_subscriptions, push_private, push_notify(), triggers mkt_push_turn (marketing_posts)
and enquiry_push (students). Browser side: /staff-sw.js and pushSetup/pushToggle in staff-shared.js.
