const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://cxjorywgtvwpsmhgxcar.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabase
    .from("transcripts")
    .select("id, version_type, is_active")
    .eq("meeting_id", "e89c6bca-2c83-4ef0-add2-a60b155f315d");

  if (error) {
    console.error(error);
    return;
  }

  const versions = {};
  data.forEach(t => {
    const key = `${t.version_type} (active: ${t.is_active})`;
    versions[key] = (versions[key] || 0) + 1;
  });
  console.log("Versions count:", versions);
}

run();
