<section class="monapay-payment-return">
  <h3>{l s='Thanh toán MONA Pay' mod='monapay'}</h3>

  {if $monapay_sandbox}
    <p class="alert alert-info">{l s='Đơn này dùng sandbox MONA Pay; không chuyển tiền thật vào mã QR thử nghiệm.' mod='monapay'}</p>
  {/if}

  {if $monapay_status === 'paid'}
    <p class="alert alert-success">{l s='MONA Pay đã xác nhận thanh toán. Cửa hàng đang xử lý đơn của bạn.' mod='monapay'}</p>
  {elseif $monapay_status === 'cancelled'}
    <p class="alert alert-warning">{l s='Bạn đã đóng trang thanh toán. Đơn vẫn được giữ ở trạng thái chờ; hãy đặt lại đơn nếu muốn tạo phiên thanh toán mới.' mod='monapay'}</p>
  {elseif $monapay_status === 'failed'}
    <p class="alert alert-danger">{l s='Chưa thể tạo trang thanh toán MONA Pay cho đơn này.' mod='monapay'}</p>
    {if $monapay_error}
      <p>{$monapay_error|escape:'htmlall':'UTF-8'}</p>
    {/if}
  {else}
    <p class="alert alert-warning">{l s='Đơn đang chờ MONA Pay xác nhận thanh toán.' mod='monapay'}</p>
    {if $monapay_checkout_url}
      <p><a class="btn btn-primary" href="{$monapay_checkout_url|escape:'htmlall':'UTF-8'}" rel="nofollow noopener">{l s='Mở lại trang thanh toán MONA Pay' mod='monapay'}</a></p>
    {/if}
  {/if}
</section>
